import Knex from "knex";
import type { Knex as KnexType } from "knex";
import { runWithWorkerKnex, getWorkerKnex } from "./poolContext.js";
import { runInTrx, getTrx, collectAfterCommitHooks, runAfterCommitHooks, type AfterCommitHook } from "./trxContext.js";

// A transaction open longer than this is almost always doing non-database work
// inside the body. Warned about in development only.
const SLOW_TRANSACTION_MS = 250;

// Import all repositories
import { MonitoringRepository } from "./repositories/monitoring.js";
import { MonitorsRepository } from "./repositories/monitors.js";
import { AlertsRepository } from "./repositories/alerts.js";
import { UsersRepository } from "./repositories/users.js";
import { SiteDataRepository } from "./repositories/site-data.js";
import { IncidentsRepository } from "./repositories/incidents.js";
import { DependenciesRepository } from "./repositories/dependencies.js";
import { RollupsRepository } from "./repositories/rollups.js";
import { SlaRepository } from "./repositories/sla.js";
import { ReportsRepository } from "./repositories/reports.js";
import { PostmortemsRepository } from "./repositories/postmortems.js";
import { IncidentTemplatesRepository } from "./repositories/incidentTemplates.js";
import { ImagesRepository } from "./repositories/images.js";
import { PagesRepository } from "./repositories/pages.js";
import { MaintenancesRepository } from "./repositories/maintenances.js";
import { MonitorAlertConfigRepository } from "./repositories/monitorAlertConfig.js";
import { AuditRepository } from "./repositories/audit.js";
import { EventsRepository } from "./repositories/events.js";
import { WebhooksRepository } from "./repositories/webhooks.js";
import { SessionsRepository } from "./repositories/sessions.js";
import { MfaRepository } from "./repositories/mfa.js";
import { SubscriptionSystemRepository } from "./repositories/subscriptionSystem.js";
import { EmailTemplateConfigRepository } from "./repositories/emailTemplateConfig.js";
import { OrgsRepository } from "./repositories/orgs.js";
import { PageDomainsRepository } from "./repositories/pageDomains.js";
import { ProbesRepository } from "./repositories/probes.js";

// Re-export types from base
export type { MonitorFilter, TriggerFilter, IncidentFilter, CountResult } from "./repositories/base.js";

// Re-export all db types for convenience
export type * from "../types/db.js";

/**
 * DbImpl - Main database implementation that composes all domain repositories
 *
 * This class delegates all operations to domain-specific repositories while
 * maintaining backward compatibility with existing code.
 */
class DbImpl {
  private knex: KnexType;
  // Dedicated pool for background jobs (Postgres/MySQL). Equals `knex` when
  // there is no separate worker pool (e.g. SQLite).
  private workerKnex: KnexType;

  // Domain repositories
  private monitoring!: MonitoringRepository;
  private monitors!: MonitorsRepository;
  private alerts!: AlertsRepository;
  private users!: UsersRepository;
  private siteData!: SiteDataRepository;
  private incidents!: IncidentsRepository;
  private dependencies!: DependenciesRepository;
  private rollups!: RollupsRepository;
  private sla!: SlaRepository;
  private reports!: ReportsRepository;
  private postmortems!: PostmortemsRepository;
  private incidentTemplates!: IncidentTemplatesRepository;

  // ============ Incident templates (C4) ============
  getIncidentTemplates!: IncidentTemplatesRepository["getIncidentTemplates"];
  getIncidentTemplateById!: IncidentTemplatesRepository["getIncidentTemplateById"];
  getIncidentTemplateByName!: IncidentTemplatesRepository["getIncidentTemplateByName"];
  insertIncidentTemplate!: IncidentTemplatesRepository["insertIncidentTemplate"];
  updateIncidentTemplate!: IncidentTemplatesRepository["updateIncidentTemplate"];
  deleteIncidentTemplate!: IncidentTemplatesRepository["deleteIncidentTemplate"];
  incrementIncidentTemplateUsage!: IncidentTemplatesRepository["incrementIncidentTemplateUsage"];

  // ============ Postmortems (C1) ============
  getPostmortemByIncidentId!: PostmortemsRepository["getPostmortemByIncidentId"];
  getPostmortemById!: PostmortemsRepository["getPostmortemById"];
  getPublishedPostmortems!: PostmortemsRepository["getPublishedPostmortems"];
  getPublishedPostmortemsForIncidents!: PostmortemsRepository["getPublishedPostmortemsForIncidents"];
  insertPostmortem!: PostmortemsRepository["insertPostmortem"];
  updatePostmortem!: PostmortemsRepository["updatePostmortem"];
  deletePostmortem!: PostmortemsRepository["deletePostmortem"];

  // ============ Component dependencies and rollup (C3) ============
  getAllDependencies!: DependenciesRepository["getAllDependencies"];
  getAllRollupSettings!: DependenciesRepository["getAllRollupSettings"];
  getMonitorsByType!: DependenciesRepository["getMonitorsByType"];
  getDependenciesForMonitor!: DependenciesRepository["getDependenciesForMonitor"];
  insertDependency!: DependenciesRepository["insertDependency"];
  deleteDependency!: DependenciesRepository["deleteDependency"];
  getRollupSetting!: DependenciesRepository["getRollupSetting"];
  upsertRollupSetting!: DependenciesRepository["upsertRollupSetting"];

  // F6b. Named for what they are rather than shortened, because `getRollups`
  // and `getRollupSetting` are already one letter apart and mean unrelated
  // things: one is a computed bucket, the other is a component's rollup mode.
  getRollupState!: RollupsRepository["getRollupState"];
  getAllRollupStates!: RollupsRepository["getAllRollupStates"];
  upsertRollupState!: RollupsRepository["upsertRollupState"];
  markRollupDirty!: RollupsRepository["markDirty"];
  takeDirtyHours!: RollupsRepository["takeDirtyHours"];
  countDirtyHours!: RollupsRepository["countDirtyHours"];
  clearDirtyHours!: RollupsRepository["clearDirtyHours"];
  upsertRollups!: RollupsRepository["upsertRollups"];
  getRollups!: RollupsRepository["getRollups"];
  streamRollups!: RollupsRepository["streamRollups"];
  getLatencySummary!: RollupsRepository["getLatencySummary"];
  getRollupBucketsAggregated!: RollupsRepository["getRollupBucketsAggregated"];
  getRollupLatencyBuckets!: RollupsRepository["getRollupLatencyBuckets"];
  getLatencyRegions!: RollupsRepository["getLatencyRegions"];
  getRawSamples!: RollupsRepository["getRawSamples"];
  deleteRollups!: RollupsRepository["deleteRollups"];
  getRawSamplesForRollup!: RollupsRepository["getRawSamples"];
  getRawSampleBounds!: RollupsRepository["getRawSampleBounds"];
  getRollupBounds!: RollupsRepository["getRollupBounds"];
  getRollupRegionIds!: RollupsRepository["getRollupRegionIds"];
  getTagsWithSamples!: RollupsRepository["getTagsWithSamples"];
  getTagsWithRollups!: RollupsRepository["getTagsWithRollups"];
  getMaintenanceWindowsForRollup!: RollupsRepository["getMaintenanceWindows"];

  // ============ SLO targets and evaluations (F1a) ============
  getSlaTargets!: SlaRepository["getSlaTargets"];
  getSlaTargetById!: SlaRepository["getSlaTargetById"];
  getSlaTargetsForMonitor!: SlaRepository["getSlaTargetsForMonitor"];
  getPublishedSlaTargets!: SlaRepository["getPublishedSlaTargets"];
  createSlaTarget!: SlaRepository["createSlaTarget"];
  updateSlaTarget!: SlaRepository["updateSlaTarget"];
  deleteSlaTarget!: SlaRepository["deleteSlaTarget"];
  getSlaEvaluations!: SlaRepository["getSlaEvaluations"];
  upsertSlaEvaluation!: SlaRepository["upsertSlaEvaluation"];
  getSloCounts!: SlaRepository["getSloCounts"];
  getReportSchedules!: ReportsRepository["getReportSchedules"];
  getReportScheduleById!: ReportsRepository["getReportScheduleById"];
  insertReportSchedule!: ReportsRepository["insertReportSchedule"];
  updateReportSchedule!: ReportsRepository["updateReportSchedule"];
  deleteReportSchedule!: ReportsRepository["deleteReportSchedule"];
  getDueReportSchedules!: ReportsRepository["getDueReportSchedules"];
  insertReportArtifact!: ReportsRepository["insertReportArtifact"];
  getArtifactByToken!: ReportsRepository["getArtifactByToken"];
  getReportArtifacts!: ReportsRepository["getReportArtifacts"];
  getExpiredArtifacts!: ReportsRepository["getExpiredArtifacts"];
  deleteArtifactRows!: ReportsRepository["deleteArtifactRows"];
  private images!: ImagesRepository;
  private pages!: PagesRepository;
  private maintenances!: MaintenancesRepository;
  private monitorAlertConfig!: MonitorAlertConfigRepository;
  private audit!: AuditRepository;
  private events!: EventsRepository;
  private webhooks!: WebhooksRepository;
  private orgs!: OrgsRepository;
  private pageDomains!: PageDomainsRepository;
  private probes!: ProbesRepository;
  private sessions!: SessionsRepository;
  private mfa!: MfaRepository;
  private subscriptionSystem!: SubscriptionSystemRepository;
  private emailTemplateConfig!: EmailTemplateConfigRepository;

  // Method bindings - declared with definite assignment assertion
  // ============ Monitoring Data ============
  insertMonitoringData!: MonitoringRepository["insertMonitoringData"];
  getMonitoringData!: MonitoringRepository["getMonitoringData"];
  getLatestMonitoringData!: MonitoringRepository["getLatestMonitoringData"];
  getLatestMonitoringDataN!: MonitoringRepository["getLatestMonitoringDataN"];
  getMonitoringDataPaginated!: MonitoringRepository["getMonitoringDataPaginated"];
  getMonitoringDataCount!: MonitoringRepository["getMonitoringDataCount"];
  getMonitoringDataAt!: MonitoringRepository["getMonitoringDataAt"];
  getLatestMonitoringDataAllActive!: MonitoringRepository["getLatestMonitoringDataAllActive"];
  getLastHeartbeat!: MonitoringRepository["getLastHeartbeat"];
  getAggregatedMonitoringData!: MonitoringRepository["getAggregatedMonitoringData"];
  getLastStatusBefore!: MonitoringRepository["getLastStatusBefore"];
  getLastStatusBeforeAll!: MonitoringRepository["getLastStatusBeforeAll"];
  getDataGroupByDayAlternative!: MonitoringRepository["getDataGroupByDayAlternative"];
  getLastStatusBeforeCombined!: MonitoringRepository["getLastStatusBeforeCombined"];
  background!: MonitoringRepository["background"];
  consecutivelyStatusFor!: MonitoringRepository["consecutivelyStatusFor"];
  consecutivelyLatencyGreaterThan!: MonitoringRepository["consecutivelyLatencyGreaterThan"];
  consecutivelyLatencyLessThan!: MonitoringRepository["consecutivelyLatencyLessThan"];
  getRecentSamplesForConfirmation!: MonitoringRepository["getRecentSamplesForConfirmation"];
  getLastObservedStatus!: MonitoringRepository["getLastObservedStatus"];
  getObservedSamplesInWindow!: MonitoringRepository["getObservedSamplesInWindow"];
  backfillConfirmedStatus!: MonitoringRepository["backfillConfirmedStatus"];
  updateMonitoringData!: MonitoringRepository["updateMonitoringData"];
  deleteMonitorDataByTag!: MonitoringRepository["deleteMonitorDataByTag"];
  getStatusCountsByInterval!: MonitoringRepository["getStatusCountsByInterval"];
  getStatusCountsByIntervalGroupedByMonitor!: MonitoringRepository["getStatusCountsByIntervalGroupedByMonitor"];
  getStatusCountsForLastN!: MonitoringRepository["getStatusCountsForLastN"];
  getLastKnownStatus!: MonitoringRepository["getLastKnownStatus"];

  // ============ Monitors ============
  getMonitorsByTags!: MonitorsRepository["getMonitorsByTags"];
  getMonitorsByTag!: MonitorsRepository["getMonitorsByTag"];
  insertMonitor!: MonitorsRepository["insertMonitor"];
  updateMonitor!: MonitorsRepository["updateMonitor"];
  updateMonitorTrigger!: MonitorsRepository["updateMonitorTrigger"];
  setMonitorCategory!: MonitorsRepository["setMonitorCategory"];
  recategoriseMonitors!: MonitorsRepository["recategoriseMonitors"];
  getMonitors!: MonitorsRepository["getMonitors"];
  getMonitorByTag!: MonitorsRepository["getMonitorByTag"];
  getMonitorBySlug!: MonitorsRepository["getMonitorBySlug"];
  getMonitorsBySlugs!: MonitorsRepository["getMonitorsBySlugs"];
  deleteMonitorsByTag!: MonitorsRepository["deleteMonitorsByTag"];

  // ============ Alerts ============
  insertAlert!: AlertsRepository["insertAlert"];
  alertExistsIncident!: AlertsRepository["alertExistsIncident"];
  alertExistsForIncidents!: AlertsRepository["alertExistsForIncidents"];
  alertExists!: AlertsRepository["alertExists"];
  getActiveAlertIncident!: AlertsRepository["getActiveAlertIncident"];
  getAllActiveAlertIncidents!: AlertsRepository["getAllActiveAlertIncidents"];
  getActiveAlert!: AlertsRepository["getActiveAlert"];
  getMonitorAlertsPaginated!: AlertsRepository["getMonitorAlertsPaginated"];
  getMonitorAlertsCount!: AlertsRepository["getMonitorAlertsCount"];
  updateAlertStatus!: AlertsRepository["updateAlertStatus"];
  incrementAlertHealthChecks!: AlertsRepository["incrementAlertHealthChecks"];
  addIncidentNumberToAlert!: AlertsRepository["addIncidentNumberToAlert"];
  deleteMonitorAlertsByTag!: AlertsRepository["deleteMonitorAlertsByTag"];

  // ============ Triggers ============
  createNewTrigger!: AlertsRepository["createNewTrigger"];
  updateTrigger!: AlertsRepository["updateTrigger"];
  getTriggers!: AlertsRepository["getTriggers"];
  getTriggerByID!: AlertsRepository["getTriggerByID"];
  getTriggersByIDs!: AlertsRepository["getTriggersByIDs"];
  deleteTrigger!: AlertsRepository["deleteTrigger"];

  // ============ Users ============
  getUsersCount!: UsersRepository["getUsersCount"];
  getUserByEmail!: UsersRepository["getUserByEmail"];
  getUserPasswordHashById!: UsersRepository["getUserPasswordHashById"];
  getUserPasswordHashesByIds!: UsersRepository["getUserPasswordHashesByIds"];
  getUserById!: UsersRepository["getUserById"];
  insertUser!: UsersRepository["insertUser"];
  updateUserPassword!: UsersRepository["updateUserPassword"];
  getAllUsers!: UsersRepository["getAllUsers"];
  getUsersPaginated!: UsersRepository["getUsersPaginated"];
  getTotalUsers!: UsersRepository["getTotalUsers"];
  getOrgUsersCount!: UsersRepository["getOrgUsersCount"];
  updateUserName!: UsersRepository["updateUserName"];
  updateUserRoles!: UsersRepository["updateUserRoles"];
  updateUserIsActive!: UsersRepository["updateUserIsActive"];
  updateUserPasswordById!: UsersRepository["updateUserPasswordById"];
  updateIsVerified!: UsersRepository["updateIsVerified"];
  updateUserProfile!: UsersRepository["updateUserProfile"];

  // ============ Roles ============
  getRoleById!: UsersRepository["getRoleById"];
  getAllRoles!: UsersRepository["getAllRoles"];
  insertRole!: UsersRepository["insertRole"];
  updateRole!: UsersRepository["updateRole"];
  deleteRole!: UsersRepository["deleteRole"];
  getUsersCountByRoleId!: UsersRepository["getUsersCountByRoleId"];
  migrateUsersRole!: UsersRepository["migrateUsersRole"];
  getRolePermissions!: UsersRepository["getRolePermissions"];
  getAllPermissions!: UsersRepository["getAllPermissions"];
  addRolePermission!: UsersRepository["addRolePermission"];
  removeRolePermission!: UsersRepository["removeRolePermission"];
  getUsersByRoleId!: UsersRepository["getUsersByRoleId"];
  addUserToRole!: UsersRepository["addUserToRole"];
  removeUserFromRole!: UsersRepository["removeUserFromRole"];
  getUserPermissionIds!: UsersRepository["getUserPermissionIds"];
  getUserRoleIds!: UsersRepository["getUserRoleIds"];

  // ============ OIDC ============
  getUserByOidcSub!: UsersRepository["getUserByOidcSub"];
  getAllOidcGroupRoleMappings!: UsersRepository["getAllOidcGroupRoleMappings"];
  getOidcGroupRoleMappingByGroup!: UsersRepository["getOidcGroupRoleMappingByGroup"];
  upsertOidcGroupRoleMapping!: UsersRepository["upsertOidcGroupRoleMapping"];
  deleteOidcGroupRoleMapping!: UsersRepository["deleteOidcGroupRoleMapping"];
  getOidcRoleIdsForGroups!: UsersRepository["getOidcRoleIdsForGroups"];

  // ============ API Keys ============
  createNewApiKey!: UsersRepository["createNewApiKey"];
  updateApiKeyStatus!: UsersRepository["updateApiKeyStatus"];
  deleteApiKey!: UsersRepository["deleteApiKey"];
  getApiKeyByHashedKey!: UsersRepository["getApiKeyByHashedKey"];
  getAllApiKeys!: UsersRepository["getAllApiKeys"];
  getApiKeyById!: UsersRepository["getApiKeyById"];
  touchApiKey!: UsersRepository["touchApiKey"];
  revokeApiKey!: UsersRepository["revokeApiKey"];
  retireApiKey!: UsersRepository["retireApiKey"];

  // ============ Site Data ============
  insertOrUpdateSiteData!: SiteDataRepository["insertOrUpdateSiteData"];
  getAllSiteData!: SiteDataRepository["getAllSiteData"];
  getSiteData!: SiteDataRepository["getSiteData"];
  getSiteDataByKey!: SiteDataRepository["getSiteDataByKey"];
  getAllSiteDataAnalytics!: SiteDataRepository["getAllSiteDataAnalytics"];
  getAllSiteDataByPrefix!: SiteDataRepository["getAllSiteDataByPrefix"];

  // ============ Incidents ============
  getIncidentsPaginated!: IncidentsRepository["getIncidentsPaginated"];
  createIncident!: IncidentsRepository["createIncident"];
  getIncidentsPaginatedDesc!: IncidentsRepository["getIncidentsPaginatedDesc"];
  getRecentUpdatedIncidents!: IncidentsRepository["getRecentUpdatedIncidents"];
  getPreviousIncidentId!: IncidentsRepository["getPreviousIncidentId"];
  getIncidentsBetween!: IncidentsRepository["getIncidentsBetween"];
  getIncidentsForMetrics!: IncidentsRepository["getIncidentsForMetrics"];
  getMonitorTagsForIncidents!: IncidentsRepository["getMonitorTagsForIncidents"];
  getIncidentsCount!: IncidentsRepository["getIncidentsCount"];
  getIncidentsCountByTypeAndDateRange!: IncidentsRepository["getIncidentsCountByTypeAndDateRange"];
  updateIncident!: IncidentsRepository["updateIncident"];
  deleteIncident!: IncidentsRepository["deleteIncident"];
  setIncidentEndTimeToNull!: IncidentsRepository["setIncidentEndTimeToNull"];
  getIncidentById!: IncidentsRepository["getIncidentById"];
  getIncidentsByIds!: IncidentsRepository["getIncidentsByIds"];
  getIncidentsByMonitorTag!: IncidentsRepository["getIncidentsByMonitorTag"];
  getIncidentsByMonitorTagRealtime!: IncidentsRepository["getIncidentsByMonitorTagRealtime"];
  getMaintenanceByMonitorTagRealtime!: IncidentsRepository["getMaintenanceByMonitorTagRealtime"];
  getOngoingMaintenances!: IncidentsRepository["getOngoingMaintenances"];
  getUpcomingMaintenances!: IncidentsRepository["getUpcomingMaintenances"];
  getLastMaintenance!: IncidentsRepository["getLastMaintenance"];
  getOngoingIncidents!: IncidentsRepository["getOngoingIncidents"];
  getLastIncident!: IncidentsRepository["getLastIncident"];
  getOngoingMaintenancesByMonitorTags!: IncidentsRepository["getOngoingMaintenancesByMonitorTags"];
  getUpcomingMaintenancesByMonitorTags!: IncidentsRepository["getUpcomingMaintenancesByMonitorTags"];
  getLastMaintenanceByMonitorTags!: IncidentsRepository["getLastMaintenanceByMonitorTags"];
  getOngoingIncidentsByMonitorTags!: IncidentsRepository["getOngoingIncidentsByMonitorTags"];
  getOngoingIncidentsForMonitorList!: IncidentsRepository["getOngoingIncidentsForMonitorList"];
  getDeclaredIncidentImpacts!: IncidentsRepository["getDeclaredIncidentImpacts"];
  getOngoingIncidentsForMonitorListWithComments!: IncidentsRepository["getOngoingIncidentsForMonitorListWithComments"];
  geAllGlobalOngoingIncidents!: IncidentsRepository["geAllGlobalOngoingIncidents"];
  getAllGlobalOngoingIncidentsWithComments!: IncidentsRepository["getAllGlobalOngoingIncidentsWithComments"];
  getResolvedIncidentsForMonitorList!: IncidentsRepository["getResolvedIncidentsForMonitorList"];
  getResolvedIncidentsForMonitorListWithComments!: IncidentsRepository["getResolvedIncidentsForMonitorListWithComments"];
  getIncidentsForEventsByDateRange!: IncidentsRepository["getIncidentsForEventsByDateRange"];
  // G7. Both a declared field AND a constructor bind, or it typechecks and
  // fails at runtime. See the note on this whitelist family.
  getPublicIncidentsPaginated!: IncidentsRepository["getPublicIncidentsPaginated"];
  getIncidentsForEventsByDateRangeMonitor!: IncidentsRepository["getIncidentsForEventsByDateRangeMonitor"];
  getLastIncidentByMonitorTags!: IncidentsRepository["getLastIncidentByMonitorTags"];
  getIncidentsCountByTypeAndDateRangeAndMonitorTags!: IncidentsRepository["getIncidentsCountByTypeAndDateRangeAndMonitorTags"];

  // ============ Incident Monitors ============
  insertIncidentMonitor!: IncidentsRepository["insertIncidentMonitor"];
  getIncidentMonitorsByIncidentID!: IncidentsRepository["getIncidentMonitorsByIncidentID"];
  getIncidentMonitorsByIncidentIDs!: IncidentsRepository["getIncidentMonitorsByIncidentIDs"];
  getMonitorsByIncidentId!: IncidentsRepository["getMonitorsByIncidentId"];
  removeIncidentMonitor!: IncidentsRepository["removeIncidentMonitor"];
  insertIncidentMonitorWithMerge!: IncidentsRepository["insertIncidentMonitorWithMerge"];
  deleteIncidentMonitorsByTag!: IncidentsRepository["deleteIncidentMonitorsByTag"];

  // ============ Incident Comments ============
  insertIncidentComment!: IncidentsRepository["insertIncidentComment"];
  getIncidentComments!: IncidentsRepository["getIncidentComments"];
  getActiveIncidentComments!: IncidentsRepository["getActiveIncidentComments"];
  getIncidentCommentByIDAndIncident!: IncidentsRepository["getIncidentCommentByIDAndIncident"];
  updateIncidentCommentByID!: IncidentsRepository["updateIncidentCommentByID"];
  updateIncidentCommentStatusByID!: IncidentsRepository["updateIncidentCommentStatusByID"];
  getIncidentCommentByID!: IncidentsRepository["getIncidentCommentByID"];
  deleteIncidentCommentsByIncidentID!: IncidentsRepository["deleteIncidentCommentsByIncidentID"];

  // ============ Images ============
  insertImage!: ImagesRepository["insertImage"];
  getImageById!: ImagesRepository["getImageById"];
  deleteImage!: ImagesRepository["deleteImage"];
  getAllImages!: ImagesRepository["getAllImages"];

  // ============ Pages ============
  createPage!: PagesRepository["createPage"];
  getPageById!: PagesRepository["getPageById"];
  getPageByPath!: PagesRepository["getPageByPath"];
  getAllPages!: PagesRepository["getAllPages"];
  updatePage!: PagesRepository["updatePage"];
  deletePage!: PagesRepository["deletePage"];

  // ============ Page Monitors ============
  addMonitorToPage!: PagesRepository["addMonitorToPage"];
  removeMonitorFromPage!: PagesRepository["removeMonitorFromPage"];
  getPageMonitors!: PagesRepository["getPageMonitors"];
  getPageMonitorsExcludeHidden!: PagesRepository["getPageMonitorsExcludeHidden"];
  getPagesByMonitorTag!: PagesRepository["getPagesByMonitorTag"];
  updatePageMonitorSettings!: PagesRepository["updatePageMonitorSettings"];
  monitorExistsOnPage!: PagesRepository["monitorExistsOnPage"];
  deletePageMonitorsByTag!: PagesRepository["deletePageMonitorsByTag"];
  deletePageMonitorsByPageId!: PagesRepository["deletePageMonitorsByPageId"];
  updatePageMonitorPositions!: PagesRepository["updatePageMonitorPositions"];

  // ============ Maintenances ============
  createMaintenance!: MaintenancesRepository["createMaintenance"];
  getMaintenanceById!: MaintenancesRepository["getMaintenanceById"];
  getMaintenancesByIds!: MaintenancesRepository["getMaintenancesByIds"];
  getAllMaintenances!: MaintenancesRepository["getAllMaintenances"];
  getMaintenancesPaginated!: MaintenancesRepository["getMaintenancesPaginated"];
  getMaintenancesCount!: MaintenancesRepository["getMaintenancesCount"];
  updateMaintenance!: MaintenancesRepository["updateMaintenance"];
  deleteMaintenance!: MaintenancesRepository["deleteMaintenance"];

  // ============ Maintenance Monitors ============
  addMonitorToMaintenance!: MaintenancesRepository["addMonitorToMaintenance"];
  addMonitorsToMaintenance!: MaintenancesRepository["addMonitorsToMaintenance"];
  addMonitorsToMaintenanceWithStatus!: MaintenancesRepository["addMonitorsToMaintenanceWithStatus"];
  removeMonitorFromMaintenance!: MaintenancesRepository["removeMonitorFromMaintenance"];
  removeAllMonitorsFromMaintenance!: MaintenancesRepository["removeAllMonitorsFromMaintenance"];
  getMaintenanceMonitors!: MaintenancesRepository["getMaintenanceMonitors"];
  getMonitorsByMaintenanceId!: MaintenancesRepository["getMonitorsByMaintenanceId"];
  getMaintenancesForMonitor!: MaintenancesRepository["getMaintenancesForMonitor"];
  deleteMaintenanceMonitorsByTag!: MaintenancesRepository["deleteMaintenanceMonitorsByTag"];
  updateMonitorImpactInMaintenanceMonitors!: MaintenancesRepository["updateMonitorImpactInMaintenanceMonitors"];

  // ============ Maintenance Events ============
  createMaintenanceEvent!: MaintenancesRepository["createMaintenanceEvent"];
  getMaintenanceEventById!: MaintenancesRepository["getMaintenanceEventById"];
  getMaintenanceEventsByMaintenanceId!: MaintenancesRepository["getMaintenanceEventsByMaintenanceId"];
  getMaintenanceEventsByMaintenanceIdWithLimits!: MaintenancesRepository["getMaintenanceEventsByMaintenanceIdWithLimits"];
  getMaintenanceEvents!: MaintenancesRepository["getMaintenanceEvents"];
  getActiveMaintenanceEvents!: MaintenancesRepository["getActiveMaintenanceEvents"];
  getMaintenanceEventsForMonitor!: MaintenancesRepository["getMaintenanceEventsForMonitor"];
  updateMaintenanceEvent!: MaintenancesRepository["updateMaintenanceEvent"];
  updateMaintenanceEventStatus!: MaintenancesRepository["updateMaintenanceEventStatus"];
  deleteMaintenanceEvent!: MaintenancesRepository["deleteMaintenanceEvent"];
  getOngoingMaintenanceEventsByMonitorTags!: MaintenancesRepository["getOngoingMaintenanceEventsByMonitorTags"];
  getUpcomingMaintenanceEventsByMonitorTags!: MaintenancesRepository["getUpcomingMaintenanceEventsByMonitorTags"];
  getMaintenancesByMonitorTagRealtime!: MaintenancesRepository["getMaintenancesByMonitorTagRealtime"];
  getScheduledEventsStartingSoon!: MaintenancesRepository["getScheduledEventsStartingSoon"];
  getScheduledEventsAlreadyStarted!: MaintenancesRepository["getScheduledEventsAlreadyStarted"];
  getReadyEventsInProgress!: MaintenancesRepository["getReadyEventsInProgress"];
  getOngoingEventsCompleted!: MaintenancesRepository["getOngoingEventsCompleted"];

  // ============ Maintenance Events for Monitor List ============
  getOngoingMaintenanceEventsForMonitorList!: MaintenancesRepository["getOngoingMaintenanceEventsForMonitorList"];
  getDeclaredMaintenanceImpacts!: MaintenancesRepository["getDeclaredMaintenanceImpacts"];
  getAllGlobalOngoingMaintenanceEvents!: MaintenancesRepository["getAllGlobalOngoingMaintenanceEvents"];
  getPastMaintenanceEventsForMonitorList!: MaintenancesRepository["getPastMaintenanceEventsForMonitorList"];
  getUpcomingMaintenanceEventsForMonitorList!: MaintenancesRepository["getUpcomingMaintenanceEventsForMonitorList"];
  getMaintenanceEventsForEventsByDateRange!: MaintenancesRepository["getMaintenanceEventsForEventsByDateRange"];
  getMaintenanceEventsForEventsByDateRangeMonitor!: MaintenancesRepository["getMaintenanceEventsForEventsByDateRangeMonitor"];
  getMaintenanceEventsWithDetails!: MaintenancesRepository["getMaintenanceEventsWithDetails"];

  // ============ Monitor Alert Config ============
  insertMonitorAlertConfig!: MonitorAlertConfigRepository["insertMonitorAlertConfig"];
  updateMonitorAlertConfig!: MonitorAlertConfigRepository["updateMonitorAlertConfig"];
  getMonitorAlertConfigById!: MonitorAlertConfigRepository["getMonitorAlertConfigById"];
  getMonitorAlertConfigs!: MonitorAlertConfigRepository["getMonitorAlertConfigs"];
  getMonitorAlertConfigsByMonitorTag!: MonitorAlertConfigRepository["getMonitorAlertConfigsByMonitorTag"];
  insertAuditLogMany!: AuditRepository["insertMany"];
  getAuditLogPaginated!: AuditRepository["getAuditLogPaginated"];
  getAuditLogCount!: AuditRepository["getAuditLogCount"];
  getAuditLogByRequestId!: AuditRepository["getAuditLogByRequestId"];
  pruneAuditLog!: AuditRepository["prune"];

  // Event bus. See events/emit.ts for the write side and events/relay.ts for the
  // read side; nothing outside those two files should need these directly.
  insertEvent!: EventsRepository["insertEvent"];
  claimUnpublishedEvents!: EventsRepository["claimUnpublished"];
  markEventsPublished!: EventsRepository["markPublished"];
  getEventByEventId!: EventsRepository["getEventByEventId"];
  getEventsPaginated!: EventsRepository["getEventsPaginated"];
  getEventsCount!: EventsRepository["getEventsCount"];
  getUnpublishedEventCount!: EventsRepository["getUnpublishedCount"];
  pruneEvents!: EventsRepository["pruneEvents"];
  insertEventDeliveries!: EventsRepository["insertDeliveries"];
  getPendingDeliveriesForEvents!: EventsRepository["getPendingDeliveriesForEvents"];
  hasEarlierIncompleteDelivery!: EventsRepository["hasEarlierIncompleteDelivery"];
  getDueDeliveries!: EventsRepository["getDueDeliveries"];
  beginEventDeliveryAttempt!: EventsRepository["beginDeliveryAttempt"];
  completeEventDeliveryAttempt!: EventsRepository["completeDeliveryAttempt"];
  setEventDeliveryStatus!: EventsRepository["setDeliveryStatus"];
  reviveStuckDeliveries!: EventsRepository["reviveStuckDeliveries"];
  getEventDeliveryById!: EventsRepository["getDeliveryById"];
  getEventDeliveriesByEventId!: EventsRepository["getDeliveriesByEventId"];
  getEventDeliveriesPaginated!: EventsRepository["getDeliveriesPaginated"];
  getEventDeliveriesCount!: EventsRepository["getDeliveriesCount"];
  resetEventDeliveryForRetry!: EventsRepository["resetDeliveryForRetry"];
  getDeadDeliveriesForTarget!: EventsRepository["getDeadDeliveriesForTarget"];
  getDeliveryConsumers!: EventsRepository["getDeliveryConsumers"];
  getDeliveryCountsByConsumer!: EventsRepository["getDeliveryCountsByConsumer"];
  getShadowDiffEventIds!: EventsRepository["getShadowDiffEventIds"];
  getShadowDiffEventCount!: EventsRepository["getShadowDiffEventCount"];
  pruneEventDeliveries!: EventsRepository["pruneDeliveries"];

  // Outbound webhook endpoints (E10). Attempts live in event_deliveries.
  // ============ MFA (A2) ============
  getTotp!: MfaRepository["getTotp"];
  putUnconfirmedTotp!: MfaRepository["putUnconfirmedTotp"];
  confirmTotp!: MfaRepository["confirmTotp"];
  consumeTotpStep!: MfaRepository["consumeTotpStep"];
  deleteTotp!: MfaRepository["deleteTotp"];
  replaceRecoveryCodes!: MfaRepository["replaceRecoveryCodes"];
  getUnusedRecoveryCodes!: MfaRepository["getUnusedRecoveryCodes"];
  useRecoveryCode!: MfaRepository["useRecoveryCode"];
  countRecoveryCodes!: MfaRepository["countRecoveryCodes"];
  deleteRecoveryCodes!: MfaRepository["deleteRecoveryCodes"];
  getUserIdsWithConfirmedTotp!: MfaRepository["getUserIdsWithConfirmedTotp"];

  // ============ Sessions (A9) ============
  createSession!: SessionsRepository["createSession"];
  getLiveSession!: SessionsRepository["getLiveSession"];
  getSessionsForUser!: SessionsRepository["getSessionsForUser"];
  revokeSession!: SessionsRepository["revokeSession"];
  revokeUserSessions!: SessionsRepository["revokeUserSessions"];
  touchSession!: SessionsRepository["touchSession"];
  setSessionOrg!: SessionsRepository["setSessionOrg"];
  setSessionMfaLevel!: SessionsRepository["setSessionMfaLevel"];
  bumpUserSessionEpoch!: SessionsRepository["bumpUserSessionEpoch"];
  getUserSessionEpoch!: SessionsRepository["getUserSessionEpoch"];
  pruneSessions!: SessionsRepository["pruneSessions"];

  createWebhookEndpoint!: WebhooksRepository["createEndpoint"];
  updateWebhookEndpoint!: WebhooksRepository["updateEndpoint"];
  deleteWebhookEndpoint!: WebhooksRepository["deleteEndpoint"];
  getWebhookEndpointById!: WebhooksRepository["getEndpointById"];
  // Organisations (P4). Unscoped by design; see repositories/orgs.ts.
  // G4. Per-page custom domains.
  getActivePageDomains!: PageDomainsRepository["getActivePageDomains"];
  getPageDomains!: PageDomainsRepository["getPageDomains"];
  getPageDomainsForOrg!: PageDomainsRepository["getPageDomainsForOrg"];
  getPageDomainById!: PageDomainsRepository["getPageDomainById"];
  getPrimaryHostnameForPage!: PageDomainsRepository["getPrimaryHostnameForPage"];
  createPageDomain!: PageDomainsRepository["createPageDomain"];
  updatePageDomain!: PageDomainsRepository["updatePageDomain"];
  setPrimaryPageDomain!: PageDomainsRepository["setPrimaryPageDomain"];
  deletePageDomain!: PageDomainsRepository["deletePageDomain"];
  hostnameExists!: PageDomainsRepository["hostnameExists"];
  // B1b/B1c. Remote probe agents and their monitor assignments.
  findProbeAgentByTokenHash!: ProbesRepository["findProbeAgentByTokenHash"];
  getAssignableRegions!: ProbesRepository["getAssignableRegions"];
  createRegion!: ProbesRepository["createRegion"];
  regionCodeExists!: ProbesRepository["regionCodeExists"];
  getProbeAgents!: ProbesRepository["getProbeAgents"];
  getProbeAgentById!: ProbesRepository["getProbeAgentById"];
  regionHasAgent!: ProbesRepository["regionHasAgent"];
  createProbeAgent!: ProbesRepository["createProbeAgent"];
  updateProbeAgent!: ProbesRepository["updateProbeAgent"];
  setProbeAgentConnection!: ProbesRepository["setProbeAgentConnection"];
  resetProbeConnectionStates!: ProbesRepository["resetProbeConnectionStates"];
  deleteProbeAgent!: ProbesRepository["deleteProbeAgent"];
  getProbeAssignments!: ProbesRepository["getProbeAssignments"];
  getProbeTargetsForMonitor!: ProbesRepository["getProbeTargetsForMonitor"];
  createProbeAssignment!: ProbesRepository["createProbeAssignment"];
  deleteProbeAssignment!: ProbesRepository["deleteProbeAssignment"];
  probeAssignmentExists!: ProbesRepository["probeAssignmentExists"];
  deleteProbeAssignmentsForMonitor!: ProbesRepository["deleteProbeAssignmentsForMonitor"];
  getOrgById!: OrgsRepository["getOrgById"];
  getOrgBySlug!: OrgsRepository["getOrgBySlug"];
  getAllOrgs!: OrgsRepository["getAllOrgs"];
  getOrgCounts!: OrgsRepository["getOrgCounts"];
  setOrgStatus!: OrgsRepository["setOrgStatus"];
  getActiveOrgIds!: OrgsRepository["getActiveOrgIds"];
  getActiveOrgDomains!: OrgsRepository["getActiveOrgDomains"];
  getAllOrgDomains!: OrgsRepository["getAllOrgDomains"];
  getOrgsForUser!: OrgsRepository["getOrgsForUser"];
  getOrgMembership!: OrgsRepository["getOrgMembership"];
  isOrgMember!: OrgsRepository["isOrgMember"];
  createOrg!: OrgsRepository["createOrg"];
  provisionNewOrg!: OrgsRepository["provisionNewOrg"];
  updateOrg!: OrgsRepository["updateOrg"];
  getOrgDomainsForOrg!: OrgsRepository["getOrgDomainsForOrg"];
  addOrgDomain!: OrgsRepository["addOrgDomain"];
  deleteOrgDomain!: OrgsRepository["deleteOrgDomain"];
  getOrgDomainByHostname!: OrgsRepository["getOrgDomainByHostname"];
  addOrgMember!: OrgsRepository["addOrgMember"];
  setOrgMemberOwner!: OrgsRepository["setOrgMemberOwner"];
  removeOrgMember!: OrgsRepository["removeOrgMember"];
  countOrgOwners!: OrgsRepository["countOrgOwners"];
  getOrgMembersDetailed!: OrgsRepository["getOrgMembersDetailed"];

  getWebhookEndpoints!: WebhooksRepository["getEndpoints"];
  getWebhookEndpointsCount!: WebhooksRepository["getEndpointsCount"];
  setWebhookEndpointEvents!: WebhooksRepository["setEndpointEvents"];
  getWebhookEndpointEvents!: WebhooksRepository["getEndpointEvents"];
  getActiveWebhookEndpointsForEvent!: WebhooksRepository["getActiveEndpointsForEvent"];
  recordWebhookEndpointOutcome!: WebhooksRepository["recordEndpointOutcome"];
  autoDisableWebhookEndpoint!: WebhooksRepository["autoDisableEndpoint"];
  getActiveMonitorAlertConfigs!: MonitorAlertConfigRepository["getActiveMonitorAlertConfigs"];
  getMonitorTagsWithActiveAlertConfigs!: MonitorAlertConfigRepository["getMonitorTagsWithActiveAlertConfigs"];
  getActiveMonitorAlertConfigsByMonitorTag!: MonitorAlertConfigRepository["getActiveMonitorAlertConfigsByMonitorTag"];
  deleteMonitorAlertConfig!: MonitorAlertConfigRepository["deleteMonitorAlertConfig"];
  deleteMonitorAlertConfigsByMonitorTag!: MonitorAlertConfigRepository["deleteMonitorAlertConfigsByMonitorTag"];
  getMonitorAlertConfigsCount!: MonitorAlertConfigRepository["getMonitorAlertConfigsCount"];
  getMonitorAlertConfigsPaginated!: MonitorAlertConfigRepository["getMonitorAlertConfigsPaginated"];

  // ============ Monitor Alert Config Triggers ============
  addTriggerToMonitorAlertConfig!: MonitorAlertConfigRepository["addTriggerToMonitorAlertConfig"];
  addTriggersToMonitorAlertConfig!: MonitorAlertConfigRepository["addTriggersToMonitorAlertConfig"];
  removeTriggerFromMonitorAlertConfig!: MonitorAlertConfigRepository["removeTriggerFromMonitorAlertConfig"];
  removeAllTriggersFromMonitorAlertConfig!: MonitorAlertConfigRepository["removeAllTriggersFromMonitorAlertConfig"];
  getMonitorAlertConfigTriggers!: MonitorAlertConfigRepository["getMonitorAlertConfigTriggers"];
  getMonitorAlertConfigTriggerIds!: MonitorAlertConfigRepository["getMonitorAlertConfigTriggerIds"];
  replaceMonitorAlertConfigTriggers!: MonitorAlertConfigRepository["replaceMonitorAlertConfigTriggers"];
  getMonitorAlertConfigWithTriggers!: MonitorAlertConfigRepository["getMonitorAlertConfigWithTriggers"];
  getMonitorAlertConfigsWithTriggersByMonitorTag!: MonitorAlertConfigRepository["getMonitorAlertConfigsWithTriggersByMonitorTag"];
  getActiveMonitorAlertConfigsWithTriggers!: MonitorAlertConfigRepository["getActiveMonitorAlertConfigsWithTriggers"];
  isTriggerUsedInMonitorAlertConfig!: MonitorAlertConfigRepository["isTriggerUsedInMonitorAlertConfig"];
  getMonitorAlertConfigsByTriggerId!: MonitorAlertConfigRepository["getMonitorAlertConfigsByTriggerId"];

  // ============ Monitor Alert Config Monitors ============
  addMonitorsToAlertConfig!: MonitorAlertConfigRepository["addMonitorsToAlertConfig"];
  removeAllMonitorsFromAlertConfig!: MonitorAlertConfigRepository["removeAllMonitorsFromAlertConfig"];
  replaceAlertConfigMonitors!: MonitorAlertConfigRepository["replaceAlertConfigMonitors"];
  getAlertConfigMonitorTags!: MonitorAlertConfigRepository["getAlertConfigMonitorTags"];

  // ============ Monitor Alerts V2 ============
  insertMonitorAlertV2!: MonitorAlertConfigRepository["insertMonitorAlertV2"];
  updateMonitorAlertV2!: MonitorAlertConfigRepository["updateMonitorAlertV2"];
  updateMonitorAlertV2Status!: MonitorAlertConfigRepository["updateMonitorAlertV2Status"];
  getMonitorAlertV2ById!: MonitorAlertConfigRepository["getMonitorAlertV2ById"];
  getMonitorAlertsV2!: MonitorAlertConfigRepository["getMonitorAlertsV2"];
  getMonitorAlertsV2ByConfigId!: MonitorAlertConfigRepository["getMonitorAlertsV2ByConfigId"];
  hasTriggeredAlertForConfig!: MonitorAlertConfigRepository["hasTriggeredAlertForConfig"];
  getActiveAlertForConfig!: MonitorAlertConfigRepository["getActiveAlertForConfig"];
  getAllTriggeredAlerts!: MonitorAlertConfigRepository["getAllTriggeredAlerts"];
  deleteMonitorAlertV2!: MonitorAlertConfigRepository["deleteMonitorAlertV2"];
  deleteMonitorAlertsV2ByConfigId!: MonitorAlertConfigRepository["deleteMonitorAlertsV2ByConfigId"];
  getMonitorAlertV2WithConfig!: MonitorAlertConfigRepository["getMonitorAlertV2WithConfig"];
  getAllTriggeredAlertsWithConfig!: MonitorAlertConfigRepository["getAllTriggeredAlertsWithConfig"];
  addIncidentToAlert!: MonitorAlertConfigRepository["addIncidentToAlert"];
  getAlertsByIncidentId!: MonitorAlertConfigRepository["getAlertsByIncidentId"];
  getMonitorAlertsV2Count!: MonitorAlertConfigRepository["getMonitorAlertsV2Count"];
  getMonitorAlertsV2Paginated!: MonitorAlertConfigRepository["getMonitorAlertsV2Paginated"];

  // ============ Subscription System V2 (subscriber_users, subscriber_methods, user_subscriptions_v2) ============
  createSubscriberUser!: SubscriptionSystemRepository["createSubscriberUser"];
  getSubscriberUserById!: SubscriptionSystemRepository["getSubscriberUserById"];
  getSubscriberUserByEmail!: SubscriptionSystemRepository["getSubscriberUserByEmail"];
  updateSubscriberUser!: SubscriptionSystemRepository["updateSubscriberUser"];
  deleteSubscriberUser!: SubscriptionSystemRepository["deleteSubscriberUser"];
  getSubscriberUsersCount!: SubscriptionSystemRepository["getSubscriberUsersCount"];
  getSubscriberUsersPaginated!: SubscriptionSystemRepository["getSubscriberUsersPaginated"];
  createSubscriberMethod!: SubscriptionSystemRepository["createSubscriberMethod"];
  getSubscriberMethodById!: SubscriptionSystemRepository["getSubscriberMethodById"];
  getSubscriberMethodsByUserId!: SubscriptionSystemRepository["getSubscriberMethodsByUserId"];
  getSubscriberMethodByUserAndType!: SubscriptionSystemRepository["getSubscriberMethodByUserAndType"];
  updateSubscriberMethod!: SubscriptionSystemRepository["updateSubscriberMethod"];
  deleteSubscriberMethod!: SubscriptionSystemRepository["deleteSubscriberMethod"];
  getActiveMethodsByType!: SubscriptionSystemRepository["getActiveMethodsByType"];
  createUserSubscriptionV2!: SubscriptionSystemRepository["createUserSubscriptionV2"];
  getUserSubscriptionV2ById!: SubscriptionSystemRepository["getUserSubscriptionV2ById"];
  getUserSubscriptionsV2!: SubscriptionSystemRepository["getUserSubscriptionsV2"];
  updateUserSubscriptionV2!: SubscriptionSystemRepository["updateUserSubscriptionV2"];
  deleteUserSubscriptionV2!: SubscriptionSystemRepository["deleteUserSubscriptionV2"];
  subscriptionV2Exists!: SubscriptionSystemRepository["subscriptionV2Exists"];
  getSubscriptionsWithMethodsForUser!: SubscriptionSystemRepository["getSubscriptionsWithMethodsForUser"];
  getSubscribersForEvent!: SubscriptionSystemRepository["getSubscribersForEvent"];
  getEmailSubscribersForPages!: SubscriptionSystemRepository["getEmailSubscribersForPages"];
  getRecipientsForScopedEvent!: SubscriptionSystemRepository["getRecipientsForScopedEvent"];
  getPageIdsForMonitorTags!: SubscriptionSystemRepository["getPageIdsForMonitorTags"];
  upsertScopedSubscription!: SubscriptionSystemRepository["upsertScopedSubscription"];
  getScopedSubscriptionsForMethod!: SubscriptionSystemRepository["getScopedSubscriptionsForMethod"];
  deleteScopedSubscription!: SubscriptionSystemRepository["deleteScopedSubscription"];
  deleteNarrowScopedSubscriptions!: SubscriptionSystemRepository["deleteNarrowScopedSubscriptions"];
  getSubscribersSummary!: SubscriptionSystemRepository["getSubscribersSummary"];
  getMethodsCountByType!: SubscriptionSystemRepository["getMethodsCountByType"];
  getSubscribersByMethodTypeV2!: SubscriptionSystemRepository["getSubscribersByMethodTypeV2"];
  getSubscriberDetailsByMethodId!: SubscriptionSystemRepository["getSubscriberDetailsByMethodId"];

  // ============ General Email Templates ============
  insertEmailTemplate!: EmailTemplateConfigRepository["insertEmailTemplate"];
  updateEmailTemplate!: EmailTemplateConfigRepository["updateEmailTemplate"];
  getAllEmailTemplates!: EmailTemplateConfigRepository["getAllEmailTemplates"];
  getEmailTemplateById!: EmailTemplateConfigRepository["getEmailTemplateById"];
  deleteEmailTemplate!: EmailTemplateConfigRepository["deleteEmailTemplate"];
  upsertEmailTemplate!: EmailTemplateConfigRepository["upsertEmailTemplate"];

  constructor(opts: KnexType.Config, workerOpts?: KnexType.Config | null) {
    this.knex = Knex(opts);
    // Separate pool for background jobs when configured (Postgres/MySQL);
    // otherwise reuse the web pool (SQLite has a single connection).
    this.workerKnex = workerOpts ? Knex(workerOpts) : this.knex;

    // Initialize repositories
    this.monitoring = new MonitoringRepository(this.knex);
    this.monitors = new MonitorsRepository(this.knex);
    this.alerts = new AlertsRepository(this.knex);
    this.users = new UsersRepository(this.knex);
    this.siteData = new SiteDataRepository(this.knex);
    this.incidents = new IncidentsRepository(this.knex);
    this.incidentTemplates = new IncidentTemplatesRepository(this.knex);
    this.getIncidentTemplates = this.incidentTemplates.getIncidentTemplates.bind(this.incidentTemplates);
    this.getIncidentTemplateById = this.incidentTemplates.getIncidentTemplateById.bind(this.incidentTemplates);
    this.getIncidentTemplateByName = this.incidentTemplates.getIncidentTemplateByName.bind(this.incidentTemplates);
    this.insertIncidentTemplate = this.incidentTemplates.insertIncidentTemplate.bind(this.incidentTemplates);
    this.updateIncidentTemplate = this.incidentTemplates.updateIncidentTemplate.bind(this.incidentTemplates);
    this.deleteIncidentTemplate = this.incidentTemplates.deleteIncidentTemplate.bind(this.incidentTemplates);
    this.incrementIncidentTemplateUsage = this.incidentTemplates.incrementIncidentTemplateUsage.bind(
      this.incidentTemplates,
    );

    this.postmortems = new PostmortemsRepository(this.knex);
    this.getPostmortemByIncidentId = this.postmortems.getPostmortemByIncidentId.bind(this.postmortems);
    this.getPostmortemById = this.postmortems.getPostmortemById.bind(this.postmortems);
    this.getPublishedPostmortems = this.postmortems.getPublishedPostmortems.bind(this.postmortems);
    this.getPublishedPostmortemsForIncidents = this.postmortems.getPublishedPostmortemsForIncidents.bind(
      this.postmortems,
    );
    this.insertPostmortem = this.postmortems.insertPostmortem.bind(this.postmortems);
    this.updatePostmortem = this.postmortems.updatePostmortem.bind(this.postmortems);
    this.deletePostmortem = this.postmortems.deletePostmortem.bind(this.postmortems);

    this.dependencies = new DependenciesRepository(this.knex);
    this.getAllDependencies = this.dependencies.getAllDependencies.bind(this.dependencies);
    this.getAllRollupSettings = this.dependencies.getAllRollupSettings.bind(this.dependencies);
    this.getMonitorsByType = this.dependencies.getMonitorsByType.bind(this.dependencies);
    this.getDependenciesForMonitor = this.dependencies.getDependenciesForMonitor.bind(this.dependencies);
    this.insertDependency = this.dependencies.insertDependency.bind(this.dependencies);
    this.deleteDependency = this.dependencies.deleteDependency.bind(this.dependencies);
    this.getRollupSetting = this.dependencies.getRollupSetting.bind(this.dependencies);
    this.upsertRollupSetting = this.dependencies.upsertRollupSetting.bind(this.dependencies);

    this.rollups = new RollupsRepository(this.knex);
    this.getRollupState = this.rollups.getRollupState.bind(this.rollups);
    this.getAllRollupStates = this.rollups.getAllRollupStates.bind(this.rollups);
    this.upsertRollupState = this.rollups.upsertRollupState.bind(this.rollups);
    this.markRollupDirty = this.rollups.markDirty.bind(this.rollups);
    this.takeDirtyHours = this.rollups.takeDirtyHours.bind(this.rollups);
    this.countDirtyHours = this.rollups.countDirtyHours.bind(this.rollups);
    this.clearDirtyHours = this.rollups.clearDirtyHours.bind(this.rollups);
    this.upsertRollups = this.rollups.upsertRollups.bind(this.rollups);
    this.getRollups = this.rollups.getRollups.bind(this.rollups);
    this.streamRollups = this.rollups.streamRollups.bind(this.rollups);
    this.getLatencySummary = this.rollups.getLatencySummary.bind(this.rollups);
    this.getRollupBucketsAggregated = this.rollups.getRollupBucketsAggregated.bind(this.rollups);
    this.getRollupLatencyBuckets = this.rollups.getRollupLatencyBuckets.bind(this.rollups);
    this.getLatencyRegions = this.rollups.getLatencyRegions.bind(this.rollups);
    this.getRawSamples = this.rollups.getRawSamples.bind(this.rollups);
    this.deleteRollups = this.rollups.deleteRollups.bind(this.rollups);
    this.getRawSamplesForRollup = this.rollups.getRawSamples.bind(this.rollups);
    this.getRawSampleBounds = this.rollups.getRawSampleBounds.bind(this.rollups);
    this.getRollupBounds = this.rollups.getRollupBounds.bind(this.rollups);
    this.getRollupRegionIds = this.rollups.getRollupRegionIds.bind(this.rollups);
    this.getTagsWithSamples = this.rollups.getTagsWithSamples.bind(this.rollups);
    this.getTagsWithRollups = this.rollups.getTagsWithRollups.bind(this.rollups);
    this.getMaintenanceWindowsForRollup = this.rollups.getMaintenanceWindows.bind(this.rollups);

    this.sla = new SlaRepository(this.knex);

    this.reports = new ReportsRepository(this.knex);
    this.getSlaTargets = this.sla.getSlaTargets.bind(this.sla);
    this.getSlaTargetById = this.sla.getSlaTargetById.bind(this.sla);
    this.getSlaTargetsForMonitor = this.sla.getSlaTargetsForMonitor.bind(this.sla);
    this.getPublishedSlaTargets = this.sla.getPublishedSlaTargets.bind(this.sla);
    this.createSlaTarget = this.sla.createSlaTarget.bind(this.sla);
    this.updateSlaTarget = this.sla.updateSlaTarget.bind(this.sla);
    this.deleteSlaTarget = this.sla.deleteSlaTarget.bind(this.sla);
    this.getSlaEvaluations = this.sla.getSlaEvaluations.bind(this.sla);
    this.getReportSchedules = this.reports.getReportSchedules.bind(this.reports);
    this.getReportScheduleById = this.reports.getReportScheduleById.bind(this.reports);
    this.insertReportSchedule = this.reports.insertReportSchedule.bind(this.reports);
    this.updateReportSchedule = this.reports.updateReportSchedule.bind(this.reports);
    this.deleteReportSchedule = this.reports.deleteReportSchedule.bind(this.reports);
    this.getDueReportSchedules = this.reports.getDueReportSchedules.bind(this.reports);
    this.insertReportArtifact = this.reports.insertReportArtifact.bind(this.reports);
    this.getArtifactByToken = this.reports.getArtifactByToken.bind(this.reports);
    this.getReportArtifacts = this.reports.getReportArtifacts.bind(this.reports);
    this.getExpiredArtifacts = this.reports.getExpiredArtifacts.bind(this.reports);
    this.deleteArtifactRows = this.reports.deleteArtifactRows.bind(this.reports);
    this.upsertSlaEvaluation = this.sla.upsertSlaEvaluation.bind(this.sla);
    this.getSloCounts = this.sla.getSloCounts.bind(this.sla);

    this.images = new ImagesRepository(this.knex);
    this.pages = new PagesRepository(this.knex);
    this.maintenances = new MaintenancesRepository(this.knex);
    this.monitorAlertConfig = new MonitorAlertConfigRepository(this.knex);
    this.audit = new AuditRepository(this.knex);
    this.events = new EventsRepository(this.knex);
    this.webhooks = new WebhooksRepository(this.knex);
    this.orgs = new OrgsRepository(this.knex);
    this.pageDomains = new PageDomainsRepository(this.knex);
    this.probes = new ProbesRepository(this.knex);
    this.sessions = new SessionsRepository(this.knex);
    this.mfa = new MfaRepository(this.knex);
    this.subscriptionSystem = new SubscriptionSystemRepository(this.knex);
    this.emailTemplateConfig = new EmailTemplateConfigRepository(this.knex);

    // Bind methods after repositories are initialized
    this.bindMonitoringMethods();
    this.bindMonitorsMethods();
    this.bindAlertsMethods();
    this.bindUsersMethods();
    this.bindSiteDataMethods();
    this.bindIncidentsMethods();
    this.bindImagesMethods();
    this.bindPagesMethods();
    this.bindMaintenancesMethods();
    this.bindMonitorAlertConfigMethods();
    this.bindSubscriptionSystemMethods();
    this.bindEmailTemplateConfigMethods();
    this.bindEventsMethods();
    this.bindWebhooksMethods();
    this.bindSessionsMethods();
    this.bindMfaMethods();

    this.init();
  }

  private bindMonitoringMethods(): void {
    this.insertMonitoringData = this.monitoring.insertMonitoringData.bind(this.monitoring);
    this.getMonitoringData = this.monitoring.getMonitoringData.bind(this.monitoring);
    this.getLatestMonitoringData = this.monitoring.getLatestMonitoringData.bind(this.monitoring);
    this.getLatestMonitoringDataN = this.monitoring.getLatestMonitoringDataN.bind(this.monitoring);
    this.getMonitoringDataPaginated = this.monitoring.getMonitoringDataPaginated.bind(this.monitoring);
    this.getMonitoringDataCount = this.monitoring.getMonitoringDataCount.bind(this.monitoring);
    this.getMonitoringDataAt = this.monitoring.getMonitoringDataAt.bind(this.monitoring);
    this.getLatestMonitoringDataAllActive = this.monitoring.getLatestMonitoringDataAllActive.bind(this.monitoring);
    this.getLastHeartbeat = this.monitoring.getLastHeartbeat.bind(this.monitoring);
    this.getAggregatedMonitoringData = this.monitoring.getAggregatedMonitoringData.bind(this.monitoring);
    this.getLastStatusBefore = this.monitoring.getLastStatusBefore.bind(this.monitoring);
    this.getLastStatusBeforeAll = this.monitoring.getLastStatusBeforeAll.bind(this.monitoring);
    this.getDataGroupByDayAlternative = this.monitoring.getDataGroupByDayAlternative.bind(this.monitoring);
    this.getLastStatusBeforeCombined = this.monitoring.getLastStatusBeforeCombined.bind(this.monitoring);
    this.background = this.monitoring.background.bind(this.monitoring);
    this.consecutivelyStatusFor = this.monitoring.consecutivelyStatusFor.bind(this.monitoring);
    this.consecutivelyLatencyGreaterThan = this.monitoring.consecutivelyLatencyGreaterThan.bind(this.monitoring);
    this.consecutivelyLatencyLessThan = this.monitoring.consecutivelyLatencyLessThan.bind(this.monitoring);
    this.getRecentSamplesForConfirmation = this.monitoring.getRecentSamplesForConfirmation.bind(this.monitoring);
    this.getLastObservedStatus = this.monitoring.getLastObservedStatus.bind(this.monitoring);
    this.getObservedSamplesInWindow = this.monitoring.getObservedSamplesInWindow.bind(this.monitoring);
    this.backfillConfirmedStatus = this.monitoring.backfillConfirmedStatus.bind(this.monitoring);
    this.updateMonitoringData = this.monitoring.updateMonitoringData.bind(this.monitoring);
    this.deleteMonitorDataByTag = this.monitoring.deleteMonitorDataByTag.bind(this.monitoring);
    this.getStatusCountsByInterval = this.monitoring.getStatusCountsByInterval.bind(this.monitoring);
    this.getStatusCountsByIntervalGroupedByMonitor = this.monitoring.getStatusCountsByIntervalGroupedByMonitor.bind(
      this.monitoring,
    );
    this.getStatusCountsForLastN = this.monitoring.getStatusCountsForLastN.bind(this.monitoring);
    this.getLastKnownStatus = this.monitoring.getLastKnownStatus.bind(this.monitoring);
  }

  private bindMonitorsMethods(): void {
    this.getMonitorsByTags = this.monitors.getMonitorsByTags.bind(this.monitors);
    this.getMonitorsByTag = this.monitors.getMonitorsByTag.bind(this.monitors);
    this.insertMonitor = this.monitors.insertMonitor.bind(this.monitors);
    this.updateMonitor = this.monitors.updateMonitor.bind(this.monitors);
    this.updateMonitorTrigger = this.monitors.updateMonitorTrigger.bind(this.monitors);
    this.setMonitorCategory = this.monitors.setMonitorCategory.bind(this.monitors);
    this.recategoriseMonitors = this.monitors.recategoriseMonitors.bind(this.monitors);
    this.getMonitors = this.monitors.getMonitors.bind(this.monitors);
    this.getMonitorByTag = this.monitors.getMonitorByTag.bind(this.monitors);
    this.getMonitorBySlug = this.monitors.getMonitorBySlug.bind(this.monitors);
    this.getMonitorsBySlugs = this.monitors.getMonitorsBySlugs.bind(this.monitors);
    this.deleteMonitorsByTag = this.monitors.deleteMonitorsByTag.bind(this.monitors);
  }

  private bindAlertsMethods(): void {
    this.insertAlert = this.alerts.insertAlert.bind(this.alerts);
    this.alertExistsIncident = this.alerts.alertExistsIncident.bind(this.alerts);
    this.alertExistsForIncidents = this.alerts.alertExistsForIncidents.bind(this.alerts);
    this.alertExists = this.alerts.alertExists.bind(this.alerts);
    this.getActiveAlertIncident = this.alerts.getActiveAlertIncident.bind(this.alerts);
    this.getAllActiveAlertIncidents = this.alerts.getAllActiveAlertIncidents.bind(this.alerts);
    this.getActiveAlert = this.alerts.getActiveAlert.bind(this.alerts);
    this.getMonitorAlertsPaginated = this.alerts.getMonitorAlertsPaginated.bind(this.alerts);
    this.getMonitorAlertsCount = this.alerts.getMonitorAlertsCount.bind(this.alerts);
    this.updateAlertStatus = this.alerts.updateAlertStatus.bind(this.alerts);
    this.incrementAlertHealthChecks = this.alerts.incrementAlertHealthChecks.bind(this.alerts);
    this.addIncidentNumberToAlert = this.alerts.addIncidentNumberToAlert.bind(this.alerts);
    this.deleteMonitorAlertsByTag = this.alerts.deleteMonitorAlertsByTag.bind(this.alerts);
    this.createNewTrigger = this.alerts.createNewTrigger.bind(this.alerts);
    this.updateTrigger = this.alerts.updateTrigger.bind(this.alerts);
    this.getTriggers = this.alerts.getTriggers.bind(this.alerts);
    this.getTriggerByID = this.alerts.getTriggerByID.bind(this.alerts);
    this.getTriggersByIDs = this.alerts.getTriggersByIDs.bind(this.alerts);
    this.deleteTrigger = this.alerts.deleteTrigger.bind(this.alerts);
  }

  private bindUsersMethods(): void {
    this.getUsersCount = this.users.getUsersCount.bind(this.users);
    this.getUserByEmail = this.users.getUserByEmail.bind(this.users);
    this.getUserPasswordHashById = this.users.getUserPasswordHashById.bind(this.users);
    this.getUserPasswordHashesByIds = this.users.getUserPasswordHashesByIds.bind(this.users);
    this.getUserById = this.users.getUserById.bind(this.users);
    this.insertUser = this.users.insertUser.bind(this.users);
    this.updateUserPassword = this.users.updateUserPassword.bind(this.users);
    this.getAllUsers = this.users.getAllUsers.bind(this.users);
    this.getUsersPaginated = this.users.getUsersPaginated.bind(this.users);
    this.getTotalUsers = this.users.getTotalUsers.bind(this.users);
    this.getOrgUsersCount = this.users.getOrgUsersCount.bind(this.users);
    this.updateUserName = this.users.updateUserName.bind(this.users);
    this.updateUserRoles = this.users.updateUserRoles.bind(this.users);
    this.updateUserIsActive = this.users.updateUserIsActive.bind(this.users);
    this.updateUserPasswordById = this.users.updateUserPasswordById.bind(this.users);
    this.updateIsVerified = this.users.updateIsVerified.bind(this.users);
    this.createNewApiKey = this.users.createNewApiKey.bind(this.users);
    this.updateApiKeyStatus = this.users.updateApiKeyStatus.bind(this.users);
    this.deleteApiKey = this.users.deleteApiKey.bind(this.users);
    this.getApiKeyByHashedKey = this.users.getApiKeyByHashedKey.bind(this.users);
    this.getAllApiKeys = this.users.getAllApiKeys.bind(this.users);
    this.getApiKeyById = this.users.getApiKeyById.bind(this.users);
    this.touchApiKey = this.users.touchApiKey.bind(this.users);
    this.revokeApiKey = this.users.revokeApiKey.bind(this.users);
    this.retireApiKey = this.users.retireApiKey.bind(this.users);
    this.updateUserProfile = this.users.updateUserProfile.bind(this.users);

    // Roles
    this.getRoleById = this.users.getRoleById.bind(this.users);
    this.getAllRoles = this.users.getAllRoles.bind(this.users);
    this.insertRole = this.users.insertRole.bind(this.users);
    this.updateRole = this.users.updateRole.bind(this.users);
    this.deleteRole = this.users.deleteRole.bind(this.users);
    this.getUsersCountByRoleId = this.users.getUsersCountByRoleId.bind(this.users);
    this.migrateUsersRole = this.users.migrateUsersRole.bind(this.users);
    this.getRolePermissions = this.users.getRolePermissions.bind(this.users);
    this.getAllPermissions = this.users.getAllPermissions.bind(this.users);
    this.addRolePermission = this.users.addRolePermission.bind(this.users);
    this.removeRolePermission = this.users.removeRolePermission.bind(this.users);
    this.getUsersByRoleId = this.users.getUsersByRoleId.bind(this.users);
    this.addUserToRole = this.users.addUserToRole.bind(this.users);
    this.removeUserFromRole = this.users.removeUserFromRole.bind(this.users);
    this.getUserPermissionIds = this.users.getUserPermissionIds.bind(this.users);
    this.getUserRoleIds = this.users.getUserRoleIds.bind(this.users);

    // OIDC
    this.getUserByOidcSub = this.users.getUserByOidcSub.bind(this.users);
    this.getAllOidcGroupRoleMappings = this.users.getAllOidcGroupRoleMappings.bind(this.users);
    this.getOidcGroupRoleMappingByGroup = this.users.getOidcGroupRoleMappingByGroup.bind(this.users);
    this.upsertOidcGroupRoleMapping = this.users.upsertOidcGroupRoleMapping.bind(this.users);
    this.deleteOidcGroupRoleMapping = this.users.deleteOidcGroupRoleMapping.bind(this.users);
    this.getOidcRoleIdsForGroups = this.users.getOidcRoleIdsForGroups.bind(this.users);
  }

  private bindSiteDataMethods(): void {
    this.insertOrUpdateSiteData = this.siteData.insertOrUpdateSiteData.bind(this.siteData);
    this.getAllSiteData = this.siteData.getAllSiteData.bind(this.siteData);
    this.getSiteData = this.siteData.getSiteData.bind(this.siteData);
    this.getSiteDataByKey = this.siteData.getSiteDataByKey.bind(this.siteData);
    this.getAllSiteDataAnalytics = this.siteData.getAllSiteDataAnalytics.bind(this.siteData);
    this.getAllSiteDataByPrefix = this.siteData.getAllSiteDataByPrefix.bind(this.siteData);
  }

  private bindIncidentsMethods(): void {
    this.getIncidentsPaginated = this.incidents.getIncidentsPaginated.bind(this.incidents);
    this.createIncident = this.incidents.createIncident.bind(this.incidents);
    this.getIncidentsPaginatedDesc = this.incidents.getIncidentsPaginatedDesc.bind(this.incidents);
    this.getRecentUpdatedIncidents = this.incidents.getRecentUpdatedIncidents.bind(this.incidents);
    this.getPreviousIncidentId = this.incidents.getPreviousIncidentId.bind(this.incidents);
    this.getIncidentsBetween = this.incidents.getIncidentsBetween.bind(this.incidents);
    this.getIncidentsForMetrics = this.incidents.getIncidentsForMetrics.bind(this.incidents);
    this.getMonitorTagsForIncidents = this.incidents.getMonitorTagsForIncidents.bind(this.incidents);
    this.getIncidentsCount = this.incidents.getIncidentsCount.bind(this.incidents);
    this.getIncidentsCountByTypeAndDateRange = this.incidents.getIncidentsCountByTypeAndDateRange.bind(this.incidents);
    this.updateIncident = this.incidents.updateIncident.bind(this.incidents);
    this.deleteIncident = this.incidents.deleteIncident.bind(this.incidents);
    this.setIncidentEndTimeToNull = this.incidents.setIncidentEndTimeToNull.bind(this.incidents);
    this.getIncidentById = this.incidents.getIncidentById.bind(this.incidents);
    this.getIncidentsByIds = this.incidents.getIncidentsByIds.bind(this.incidents);
    this.getIncidentsByMonitorTag = this.incidents.getIncidentsByMonitorTag.bind(this.incidents);
    this.getIncidentsByMonitorTagRealtime = this.incidents.getIncidentsByMonitorTagRealtime.bind(this.incidents);
    this.getMaintenanceByMonitorTagRealtime = this.incidents.getMaintenanceByMonitorTagRealtime.bind(this.incidents);
    this.getOngoingMaintenances = this.incidents.getOngoingMaintenances.bind(this.incidents);
    this.getUpcomingMaintenances = this.incidents.getUpcomingMaintenances.bind(this.incidents);
    this.getLastMaintenance = this.incidents.getLastMaintenance.bind(this.incidents);
    this.getOngoingIncidents = this.incidents.getOngoingIncidents.bind(this.incidents);
    this.getLastIncident = this.incidents.getLastIncident.bind(this.incidents);
    this.getOngoingMaintenancesByMonitorTags = this.incidents.getOngoingMaintenancesByMonitorTags.bind(this.incidents);
    this.getUpcomingMaintenancesByMonitorTags = this.incidents.getUpcomingMaintenancesByMonitorTags.bind(
      this.incidents,
    );
    this.getLastMaintenanceByMonitorTags = this.incidents.getLastMaintenanceByMonitorTags.bind(this.incidents);
    this.getOngoingIncidentsByMonitorTags = this.incidents.getOngoingIncidentsByMonitorTags.bind(this.incidents);
    this.getOngoingIncidentsForMonitorList = this.incidents.getOngoingIncidentsForMonitorList.bind(this.incidents);
    this.getDeclaredIncidentImpacts = this.incidents.getDeclaredIncidentImpacts.bind(this.incidents);
    this.getOngoingIncidentsForMonitorListWithComments =
      this.incidents.getOngoingIncidentsForMonitorListWithComments.bind(this.incidents);
    this.getResolvedIncidentsForMonitorList = this.incidents.getResolvedIncidentsForMonitorList.bind(this.incidents);
    this.geAllGlobalOngoingIncidents = this.incidents.geAllGlobalOngoingIncidents.bind(this.incidents);
    this.getAllGlobalOngoingIncidentsWithComments = this.incidents.getAllGlobalOngoingIncidentsWithComments.bind(
      this.incidents,
    );
    this.getResolvedIncidentsForMonitorListWithComments =
      this.incidents.getResolvedIncidentsForMonitorListWithComments.bind(this.incidents);
    this.getIncidentsForEventsByDateRange = this.incidents.getIncidentsForEventsByDateRange.bind(this.incidents);
    this.getPublicIncidentsPaginated = this.incidents.getPublicIncidentsPaginated.bind(this.incidents);
    this.getIncidentsForEventsByDateRangeMonitor = this.incidents.getIncidentsForEventsByDateRangeMonitor.bind(
      this.incidents,
    );
    this.getLastIncidentByMonitorTags = this.incidents.getLastIncidentByMonitorTags.bind(this.incidents);
    this.getIncidentsCountByTypeAndDateRangeAndMonitorTags =
      this.incidents.getIncidentsCountByTypeAndDateRangeAndMonitorTags.bind(this.incidents);
    this.insertIncidentMonitor = this.incidents.insertIncidentMonitor.bind(this.incidents);
    this.getIncidentMonitorsByIncidentID = this.incidents.getIncidentMonitorsByIncidentID.bind(this.incidents);
    this.getIncidentMonitorsByIncidentIDs = this.incidents.getIncidentMonitorsByIncidentIDs.bind(this.incidents);
    this.getMonitorsByIncidentId = this.incidents.getMonitorsByIncidentId.bind(this.incidents);
    this.removeIncidentMonitor = this.incidents.removeIncidentMonitor.bind(this.incidents);
    this.insertIncidentMonitorWithMerge = this.incidents.insertIncidentMonitorWithMerge.bind(this.incidents);
    this.deleteIncidentMonitorsByTag = this.incidents.deleteIncidentMonitorsByTag.bind(this.incidents);
    this.insertIncidentComment = this.incidents.insertIncidentComment.bind(this.incidents);
    this.getIncidentComments = this.incidents.getIncidentComments.bind(this.incidents);
    this.getActiveIncidentComments = this.incidents.getActiveIncidentComments.bind(this.incidents);
    this.getIncidentCommentByIDAndIncident = this.incidents.getIncidentCommentByIDAndIncident.bind(this.incidents);
    this.updateIncidentCommentByID = this.incidents.updateIncidentCommentByID.bind(this.incidents);
    this.updateIncidentCommentStatusByID = this.incidents.updateIncidentCommentStatusByID.bind(this.incidents);
    this.getIncidentCommentByID = this.incidents.getIncidentCommentByID.bind(this.incidents);
    this.deleteIncidentCommentsByIncidentID = this.incidents.deleteIncidentCommentsByIncidentID.bind(this.incidents);
  }

  private bindImagesMethods(): void {
    this.insertImage = this.images.insertImage.bind(this.images);
    this.getImageById = this.images.getImageById.bind(this.images);
    this.deleteImage = this.images.deleteImage.bind(this.images);
    this.getAllImages = this.images.getAllImages.bind(this.images);
  }

  private bindPagesMethods(): void {
    this.createPage = this.pages.createPage.bind(this.pages);
    this.getPageById = this.pages.getPageById.bind(this.pages);
    this.getPageByPath = this.pages.getPageByPath.bind(this.pages);
    this.getAllPages = this.pages.getAllPages.bind(this.pages);
    this.updatePage = this.pages.updatePage.bind(this.pages);
    this.deletePage = this.pages.deletePage.bind(this.pages);
    this.addMonitorToPage = this.pages.addMonitorToPage.bind(this.pages);
    this.removeMonitorFromPage = this.pages.removeMonitorFromPage.bind(this.pages);
    this.getPageMonitors = this.pages.getPageMonitors.bind(this.pages);
    this.getPageMonitorsExcludeHidden = this.pages.getPageMonitorsExcludeHidden.bind(this.pages);
    this.getPagesByMonitorTag = this.pages.getPagesByMonitorTag.bind(this.pages);
    this.updatePageMonitorSettings = this.pages.updatePageMonitorSettings.bind(this.pages);
    this.monitorExistsOnPage = this.pages.monitorExistsOnPage.bind(this.pages);
    this.deletePageMonitorsByTag = this.pages.deletePageMonitorsByTag.bind(this.pages);
    this.deletePageMonitorsByPageId = this.pages.deletePageMonitorsByPageId.bind(this.pages);
    this.updatePageMonitorPositions = this.pages.updatePageMonitorPositions.bind(this.pages);
  }

  private bindMaintenancesMethods(): void {
    this.createMaintenance = this.maintenances.createMaintenance.bind(this.maintenances);
    this.getMaintenanceById = this.maintenances.getMaintenanceById.bind(this.maintenances);
    this.getMaintenancesByIds = this.maintenances.getMaintenancesByIds.bind(this.maintenances);
    this.getAllMaintenances = this.maintenances.getAllMaintenances.bind(this.maintenances);
    this.getMaintenancesPaginated = this.maintenances.getMaintenancesPaginated.bind(this.maintenances);
    this.getMaintenancesCount = this.maintenances.getMaintenancesCount.bind(this.maintenances);
    this.updateMaintenance = this.maintenances.updateMaintenance.bind(this.maintenances);
    this.deleteMaintenance = this.maintenances.deleteMaintenance.bind(this.maintenances);
    this.addMonitorToMaintenance = this.maintenances.addMonitorToMaintenance.bind(this.maintenances);
    this.addMonitorsToMaintenance = this.maintenances.addMonitorsToMaintenance.bind(this.maintenances);
    this.addMonitorsToMaintenanceWithStatus = this.maintenances.addMonitorsToMaintenanceWithStatus.bind(
      this.maintenances,
    );
    this.removeMonitorFromMaintenance = this.maintenances.removeMonitorFromMaintenance.bind(this.maintenances);
    this.removeAllMonitorsFromMaintenance = this.maintenances.removeAllMonitorsFromMaintenance.bind(this.maintenances);
    this.getMaintenanceMonitors = this.maintenances.getMaintenanceMonitors.bind(this.maintenances);
    this.getMonitorsByMaintenanceId = this.maintenances.getMonitorsByMaintenanceId.bind(this.maintenances);
    this.getMaintenancesForMonitor = this.maintenances.getMaintenancesForMonitor.bind(this.maintenances);
    this.deleteMaintenanceMonitorsByTag = this.maintenances.deleteMaintenanceMonitorsByTag.bind(this.maintenances);
    this.updateMonitorImpactInMaintenanceMonitors = this.maintenances.updateMonitorImpactInMaintenanceMonitors.bind(
      this.maintenances,
    );
    this.createMaintenanceEvent = this.maintenances.createMaintenanceEvent.bind(this.maintenances);
    this.getMaintenanceEventById = this.maintenances.getMaintenanceEventById.bind(this.maintenances);
    this.getMaintenanceEventsByMaintenanceId = this.maintenances.getMaintenanceEventsByMaintenanceId.bind(
      this.maintenances,
    );
    this.getMaintenanceEventsByMaintenanceIdWithLimits =
      this.maintenances.getMaintenanceEventsByMaintenanceIdWithLimits.bind(this.maintenances);
    this.getMaintenanceEvents = this.maintenances.getMaintenanceEvents.bind(this.maintenances);
    this.getActiveMaintenanceEvents = this.maintenances.getActiveMaintenanceEvents.bind(this.maintenances);
    this.getMaintenancesByMonitorTagRealtime = this.maintenances.getMaintenancesByMonitorTagRealtime.bind(
      this.maintenances,
    );
    this.getMaintenanceEventsForMonitor = this.maintenances.getMaintenanceEventsForMonitor.bind(this.maintenances);
    this.updateMaintenanceEvent = this.maintenances.updateMaintenanceEvent.bind(this.maintenances);
    this.updateMaintenanceEventStatus = this.maintenances.updateMaintenanceEventStatus.bind(this.maintenances);
    this.deleteMaintenanceEvent = this.maintenances.deleteMaintenanceEvent.bind(this.maintenances);
    this.getOngoingMaintenanceEventsByMonitorTags = this.maintenances.getOngoingMaintenanceEventsByMonitorTags.bind(
      this.maintenances,
    );
    this.getUpcomingMaintenanceEventsByMonitorTags = this.maintenances.getUpcomingMaintenanceEventsByMonitorTags.bind(
      this.maintenances,
    );
    this.getDeclaredMaintenanceImpacts = this.maintenances.getDeclaredMaintenanceImpacts.bind(this.maintenances);
    this.getOngoingMaintenanceEventsForMonitorList = this.maintenances.getOngoingMaintenanceEventsForMonitorList.bind(
      this.maintenances,
    );
    this.getAllGlobalOngoingMaintenanceEvents = this.maintenances.getAllGlobalOngoingMaintenanceEvents.bind(
      this.maintenances,
    );
    this.getPastMaintenanceEventsForMonitorList = this.maintenances.getPastMaintenanceEventsForMonitorList.bind(
      this.maintenances,
    );
    this.getUpcomingMaintenanceEventsForMonitorList = this.maintenances.getUpcomingMaintenanceEventsForMonitorList.bind(
      this.maintenances,
    );
    this.getMaintenanceEventsForEventsByDateRange = this.maintenances.getMaintenanceEventsForEventsByDateRange.bind(
      this.maintenances,
    );
    this.getMaintenanceEventsForEventsByDateRangeMonitor =
      this.maintenances.getMaintenanceEventsForEventsByDateRangeMonitor.bind(this.maintenances);
    this.getMaintenanceEventsWithDetails = this.maintenances.getMaintenanceEventsWithDetails.bind(this.maintenances);
    this.getScheduledEventsStartingSoon = this.maintenances.getScheduledEventsStartingSoon.bind(this.maintenances);
    this.getScheduledEventsAlreadyStarted = this.maintenances.getScheduledEventsAlreadyStarted.bind(this.maintenances);
    this.getReadyEventsInProgress = this.maintenances.getReadyEventsInProgress.bind(this.maintenances);
    this.getOngoingEventsCompleted = this.maintenances.getOngoingEventsCompleted.bind(this.maintenances);
  }

  private bindMonitorAlertConfigMethods(): void {
    // Monitor Alert Config CRUD
    this.insertMonitorAlertConfig = this.monitorAlertConfig.insertMonitorAlertConfig.bind(this.monitorAlertConfig);
    this.updateMonitorAlertConfig = this.monitorAlertConfig.updateMonitorAlertConfig.bind(this.monitorAlertConfig);
    this.getMonitorAlertConfigById = this.monitorAlertConfig.getMonitorAlertConfigById.bind(this.monitorAlertConfig);
    this.getMonitorAlertConfigs = this.monitorAlertConfig.getMonitorAlertConfigs.bind(this.monitorAlertConfig);
    this.getMonitorAlertConfigsByMonitorTag = this.monitorAlertConfig.getMonitorAlertConfigsByMonitorTag.bind(
      this.monitorAlertConfig,
    );
    this.getActiveMonitorAlertConfigs = this.monitorAlertConfig.getActiveMonitorAlertConfigs.bind(
      this.monitorAlertConfig,
    );
    this.insertAuditLogMany = this.audit.insertMany.bind(this.audit);
    this.getAuditLogPaginated = this.audit.getAuditLogPaginated.bind(this.audit);
    this.getAuditLogCount = this.audit.getAuditLogCount.bind(this.audit);
    this.getAuditLogByRequestId = this.audit.getAuditLogByRequestId.bind(this.audit);
    this.pruneAuditLog = this.audit.prune.bind(this.audit);
    this.getMonitorTagsWithActiveAlertConfigs = this.monitorAlertConfig.getMonitorTagsWithActiveAlertConfigs.bind(
      this.monitorAlertConfig,
    );
    this.getActiveMonitorAlertConfigsByMonitorTag =
      this.monitorAlertConfig.getActiveMonitorAlertConfigsByMonitorTag.bind(this.monitorAlertConfig);
    this.deleteMonitorAlertConfig = this.monitorAlertConfig.deleteMonitorAlertConfig.bind(this.monitorAlertConfig);
    this.deleteMonitorAlertConfigsByMonitorTag = this.monitorAlertConfig.deleteMonitorAlertConfigsByMonitorTag.bind(
      this.monitorAlertConfig,
    );
    this.getMonitorAlertConfigsCount = this.monitorAlertConfig.getMonitorAlertConfigsCount.bind(
      this.monitorAlertConfig,
    );
    this.getMonitorAlertConfigsPaginated = this.monitorAlertConfig.getMonitorAlertConfigsPaginated.bind(
      this.monitorAlertConfig,
    );

    // Monitor Alert Config Triggers
    this.addTriggerToMonitorAlertConfig = this.monitorAlertConfig.addTriggerToMonitorAlertConfig.bind(
      this.monitorAlertConfig,
    );
    this.addTriggersToMonitorAlertConfig = this.monitorAlertConfig.addTriggersToMonitorAlertConfig.bind(
      this.monitorAlertConfig,
    );
    this.removeTriggerFromMonitorAlertConfig = this.monitorAlertConfig.removeTriggerFromMonitorAlertConfig.bind(
      this.monitorAlertConfig,
    );
    this.removeAllTriggersFromMonitorAlertConfig = this.monitorAlertConfig.removeAllTriggersFromMonitorAlertConfig.bind(
      this.monitorAlertConfig,
    );
    this.getMonitorAlertConfigTriggers = this.monitorAlertConfig.getMonitorAlertConfigTriggers.bind(
      this.monitorAlertConfig,
    );
    this.getMonitorAlertConfigTriggerIds = this.monitorAlertConfig.getMonitorAlertConfigTriggerIds.bind(
      this.monitorAlertConfig,
    );
    this.replaceMonitorAlertConfigTriggers = this.monitorAlertConfig.replaceMonitorAlertConfigTriggers.bind(
      this.monitorAlertConfig,
    );

    // Composite operations
    this.getMonitorAlertConfigWithTriggers = this.monitorAlertConfig.getMonitorAlertConfigWithTriggers.bind(
      this.monitorAlertConfig,
    );
    this.getMonitorAlertConfigsWithTriggersByMonitorTag =
      this.monitorAlertConfig.getMonitorAlertConfigsWithTriggersByMonitorTag.bind(this.monitorAlertConfig);
    this.getActiveMonitorAlertConfigsWithTriggers =
      this.monitorAlertConfig.getActiveMonitorAlertConfigsWithTriggers.bind(this.monitorAlertConfig);
    this.isTriggerUsedInMonitorAlertConfig = this.monitorAlertConfig.isTriggerUsedInMonitorAlertConfig.bind(
      this.monitorAlertConfig,
    );
    this.getMonitorAlertConfigsByTriggerId = this.monitorAlertConfig.getMonitorAlertConfigsByTriggerId.bind(
      this.monitorAlertConfig,
    );

    // Monitor Alert Config Monitors
    this.addMonitorsToAlertConfig = this.monitorAlertConfig.addMonitorsToAlertConfig.bind(this.monitorAlertConfig);
    this.removeAllMonitorsFromAlertConfig = this.monitorAlertConfig.removeAllMonitorsFromAlertConfig.bind(
      this.monitorAlertConfig,
    );
    this.replaceAlertConfigMonitors = this.monitorAlertConfig.replaceAlertConfigMonitors.bind(this.monitorAlertConfig);
    this.getAlertConfigMonitorTags = this.monitorAlertConfig.getAlertConfigMonitorTags.bind(this.monitorAlertConfig);

    // Monitor Alerts V2
    this.insertMonitorAlertV2 = this.monitorAlertConfig.insertMonitorAlertV2.bind(this.monitorAlertConfig);
    this.updateMonitorAlertV2 = this.monitorAlertConfig.updateMonitorAlertV2.bind(this.monitorAlertConfig);
    this.updateMonitorAlertV2Status = this.monitorAlertConfig.updateMonitorAlertV2Status.bind(this.monitorAlertConfig);
    this.getMonitorAlertV2ById = this.monitorAlertConfig.getMonitorAlertV2ById.bind(this.monitorAlertConfig);
    this.getMonitorAlertsV2 = this.monitorAlertConfig.getMonitorAlertsV2.bind(this.monitorAlertConfig);
    this.getMonitorAlertsV2ByConfigId = this.monitorAlertConfig.getMonitorAlertsV2ByConfigId.bind(
      this.monitorAlertConfig,
    );
    this.hasTriggeredAlertForConfig = this.monitorAlertConfig.hasTriggeredAlertForConfig.bind(this.monitorAlertConfig);
    this.getActiveAlertForConfig = this.monitorAlertConfig.getActiveAlertForConfig.bind(this.monitorAlertConfig);
    this.getAllTriggeredAlerts = this.monitorAlertConfig.getAllTriggeredAlerts.bind(this.monitorAlertConfig);
    this.deleteMonitorAlertV2 = this.monitorAlertConfig.deleteMonitorAlertV2.bind(this.monitorAlertConfig);
    this.deleteMonitorAlertsV2ByConfigId = this.monitorAlertConfig.deleteMonitorAlertsV2ByConfigId.bind(
      this.monitorAlertConfig,
    );
    this.getMonitorAlertV2WithConfig = this.monitorAlertConfig.getMonitorAlertV2WithConfig.bind(
      this.monitorAlertConfig,
    );
    this.getAllTriggeredAlertsWithConfig = this.monitorAlertConfig.getAllTriggeredAlertsWithConfig.bind(
      this.monitorAlertConfig,
    );
    this.addIncidentToAlert = this.monitorAlertConfig.addIncidentToAlert.bind(this.monitorAlertConfig);
    this.getAlertsByIncidentId = this.monitorAlertConfig.getAlertsByIncidentId.bind(this.monitorAlertConfig);
    this.getMonitorAlertsV2Count = this.monitorAlertConfig.getMonitorAlertsV2Count.bind(this.monitorAlertConfig);
    this.getMonitorAlertsV2Paginated = this.monitorAlertConfig.getMonitorAlertsV2Paginated.bind(
      this.monitorAlertConfig,
    );
  }

  private bindSubscriptionSystemMethods(): void {
    // Subscriber Users
    this.createSubscriberUser = this.subscriptionSystem.createSubscriberUser.bind(this.subscriptionSystem);
    this.getSubscriberUserById = this.subscriptionSystem.getSubscriberUserById.bind(this.subscriptionSystem);
    this.getSubscriberUserByEmail = this.subscriptionSystem.getSubscriberUserByEmail.bind(this.subscriptionSystem);
    this.updateSubscriberUser = this.subscriptionSystem.updateSubscriberUser.bind(this.subscriptionSystem);
    this.deleteSubscriberUser = this.subscriptionSystem.deleteSubscriberUser.bind(this.subscriptionSystem);
    this.getSubscriberUsersCount = this.subscriptionSystem.getSubscriberUsersCount.bind(this.subscriptionSystem);
    this.getSubscriberUsersPaginated = this.subscriptionSystem.getSubscriberUsersPaginated.bind(
      this.subscriptionSystem,
    );

    // Subscriber Methods
    this.createSubscriberMethod = this.subscriptionSystem.createSubscriberMethod.bind(this.subscriptionSystem);
    this.getSubscriberMethodById = this.subscriptionSystem.getSubscriberMethodById.bind(this.subscriptionSystem);
    this.getSubscriberMethodsByUserId = this.subscriptionSystem.getSubscriberMethodsByUserId.bind(
      this.subscriptionSystem,
    );
    this.getSubscriberMethodByUserAndType = this.subscriptionSystem.getSubscriberMethodByUserAndType.bind(
      this.subscriptionSystem,
    );
    this.updateSubscriberMethod = this.subscriptionSystem.updateSubscriberMethod.bind(this.subscriptionSystem);
    this.deleteSubscriberMethod = this.subscriptionSystem.deleteSubscriberMethod.bind(this.subscriptionSystem);
    this.getActiveMethodsByType = this.subscriptionSystem.getActiveMethodsByType.bind(this.subscriptionSystem);

    // User Subscriptions V2
    this.createUserSubscriptionV2 = this.subscriptionSystem.createUserSubscriptionV2.bind(this.subscriptionSystem);
    this.getUserSubscriptionV2ById = this.subscriptionSystem.getUserSubscriptionV2ById.bind(this.subscriptionSystem);
    this.getUserSubscriptionsV2 = this.subscriptionSystem.getUserSubscriptionsV2.bind(this.subscriptionSystem);
    this.updateUserSubscriptionV2 = this.subscriptionSystem.updateUserSubscriptionV2.bind(this.subscriptionSystem);
    this.deleteUserSubscriptionV2 = this.subscriptionSystem.deleteUserSubscriptionV2.bind(this.subscriptionSystem);
    this.subscriptionV2Exists = this.subscriptionSystem.subscriptionV2Exists.bind(this.subscriptionSystem);

    // Complex Queries
    this.getSubscriptionsWithMethodsForUser = this.subscriptionSystem.getSubscriptionsWithMethodsForUser.bind(
      this.subscriptionSystem,
    );
    this.getSubscribersForEvent = this.subscriptionSystem.getSubscribersForEvent.bind(this.subscriptionSystem);
    this.getEmailSubscribersForPages = this.subscriptionSystem.getEmailSubscribersForPages.bind(
      this.subscriptionSystem,
    );
    this.getRecipientsForScopedEvent = this.subscriptionSystem.getRecipientsForScopedEvent.bind(
      this.subscriptionSystem,
    );
    this.getPageIdsForMonitorTags = this.subscriptionSystem.getPageIdsForMonitorTags.bind(this.subscriptionSystem);
    this.upsertScopedSubscription = this.subscriptionSystem.upsertScopedSubscription.bind(this.subscriptionSystem);
    this.getScopedSubscriptionsForMethod = this.subscriptionSystem.getScopedSubscriptionsForMethod.bind(
      this.subscriptionSystem,
    );
    this.deleteScopedSubscription = this.subscriptionSystem.deleteScopedSubscription.bind(this.subscriptionSystem);
    this.deleteNarrowScopedSubscriptions = this.subscriptionSystem.deleteNarrowScopedSubscriptions.bind(
      this.subscriptionSystem,
    );
    this.getSubscribersSummary = this.subscriptionSystem.getSubscribersSummary.bind(this.subscriptionSystem);

    // Admin methods for listing by method type
    this.getMethodsCountByType = this.subscriptionSystem.getMethodsCountByType.bind(this.subscriptionSystem);
    this.getSubscribersByMethodTypeV2 = this.subscriptionSystem.getSubscribersByMethodTypeV2.bind(
      this.subscriptionSystem,
    );
    this.getSubscriberDetailsByMethodId = this.subscriptionSystem.getSubscriberDetailsByMethodId.bind(
      this.subscriptionSystem,
    );
  }

  private bindEmailTemplateConfigMethods(): void {
    // General Email Templates
    this.insertEmailTemplate = this.emailTemplateConfig.insertEmailTemplate.bind(this.emailTemplateConfig);
    this.updateEmailTemplate = this.emailTemplateConfig.updateEmailTemplate.bind(this.emailTemplateConfig);
    this.getAllEmailTemplates = this.emailTemplateConfig.getAllEmailTemplates.bind(this.emailTemplateConfig);
    this.getEmailTemplateById = this.emailTemplateConfig.getEmailTemplateById.bind(this.emailTemplateConfig);
    this.deleteEmailTemplate = this.emailTemplateConfig.deleteEmailTemplate.bind(this.emailTemplateConfig);
    this.upsertEmailTemplate = this.emailTemplateConfig.upsertEmailTemplate.bind(this.emailTemplateConfig);
  }

  async init(): Promise<void> {}

  /**
   * Runs `fn` with all repository queries routed to the worker connection pool.
   * Wrap background work (BullMQ job processors, schedulers) with this so a
   * burst of jobs cannot exhaust the web pool that serves page loads.
   */
  runInWorkerContext<T>(fn: () => Promise<T>): Promise<T> {
    return runWithWorkerKnex(this.workerKnex, fn);
  }

  /**
   * Runs `fn` inside a database transaction that every repository call made
   * within it automatically joins. Commits when `fn` resolves, rolls back when
   * it throws.
   *
   *     await db.withTransaction(async () => {
   *       await db.createIncident(...);
   *       await db.addIncidentMonitor(...);   // same transaction, no plumbing
   *     });
   *
   * **Reentrant.** If a transaction is already open in this context, `fn` joins
   * it and does not start a nested one. So a helper that wraps its own writes
   * stays correct when called from inside a larger transaction: the outermost
   * caller decides the commit boundary. The consequence is that an inner
   * `withTransaction` cannot commit independently, which is the intended
   * behaviour and not a limitation to work around.
   *
   * **Keep the body to database work only.** No `fetch`, no queue pushes, no
   * `GetAllSiteData()` (it reads Redis). On SQLite this is not a style
   * preference: better-sqlite3 transactions are synchronous and hold a lock on
   * the entire database file, so awaiting anything slow inside one stalls every
   * other query in the process. Gather what you need first, then open the
   * transaction. Compute, notify and enqueue after it commits, since work
   * enqueued inside a transaction can be picked up by a worker before the
   * transaction commits, and then it reads state that does not exist yet.
   *
   * When the code that knows work is needed is itself inside the body, use
   * `afterCommit(fn)` from trxContext: it defers `fn` to just after the commit,
   * and drops it entirely on a rollback.
   */
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const existing = getTrx();
    if (existing) {
      // Already inside one: join it. Nesting here would either deadlock on
      // SQLite or create a savepoint whose rollback semantics differ per
      // dialect, and neither is what a caller expects.
      return await fn();
    }

    const knex = getWorkerKnex() ?? this.knex;
    const startedAt = Date.now();
    // Work registered with `afterCommit` inside the body lands here and runs
    // below, once the commit has actually happened. A rollback throws before
    // that point, so the hooks are dropped with the transaction, which is the
    // entire reason they are deferred rather than run inline.
    const hooks: AfterCommitHook[] = [];
    let elapsed = 0;
    try {
      const result = await knex.transaction((trx) => runInTrx(trx, () => collectAfterCommitHooks(hooks, fn)));
      // Measured before the hooks run: they are deliberately outside the
      // transaction, so counting them would report a slow transaction that was
      // never actually held open.
      elapsed = Date.now() - startedAt;
      await runAfterCommitHooks(hooks);
      return result;
    } finally {
      // Dev-only, because the cost of a long transaction is invisible until it
      // is someone else's timeout. See the SQLite note above.
      if (elapsed === 0) elapsed = Date.now() - startedAt;
      if (elapsed > SLOW_TRANSACTION_MS && process.env.NODE_ENV !== "production") {
        console.warn(
          `Slow transaction: held for ${elapsed}ms. Transaction bodies should do database work only; ` +
            `move fetches, queue pushes and cache reads outside. See DbImpl.withTransaction.`,
        );
      }
    }
  }

  private bindEventsMethods(): void {
    this.insertEvent = this.events.insertEvent.bind(this.events);
    this.claimUnpublishedEvents = this.events.claimUnpublished.bind(this.events);
    this.markEventsPublished = this.events.markPublished.bind(this.events);
    this.getEventByEventId = this.events.getEventByEventId.bind(this.events);
    this.getEventsPaginated = this.events.getEventsPaginated.bind(this.events);
    this.getEventsCount = this.events.getEventsCount.bind(this.events);
    this.getUnpublishedEventCount = this.events.getUnpublishedCount.bind(this.events);
    this.pruneEvents = this.events.pruneEvents.bind(this.events);
    this.insertEventDeliveries = this.events.insertDeliveries.bind(this.events);
    this.getPendingDeliveriesForEvents = this.events.getPendingDeliveriesForEvents.bind(this.events);
    this.hasEarlierIncompleteDelivery = this.events.hasEarlierIncompleteDelivery.bind(this.events);
    this.getDueDeliveries = this.events.getDueDeliveries.bind(this.events);
    this.beginEventDeliveryAttempt = this.events.beginDeliveryAttempt.bind(this.events);
    this.completeEventDeliveryAttempt = this.events.completeDeliveryAttempt.bind(this.events);
    this.setEventDeliveryStatus = this.events.setDeliveryStatus.bind(this.events);
    this.reviveStuckDeliveries = this.events.reviveStuckDeliveries.bind(this.events);
    this.getEventDeliveryById = this.events.getDeliveryById.bind(this.events);
    this.getEventDeliveriesByEventId = this.events.getDeliveriesByEventId.bind(this.events);
    this.getEventDeliveriesPaginated = this.events.getDeliveriesPaginated.bind(this.events);
    this.getEventDeliveriesCount = this.events.getDeliveriesCount.bind(this.events);
    this.resetEventDeliveryForRetry = this.events.resetDeliveryForRetry.bind(this.events);
    this.getDeadDeliveriesForTarget = this.events.getDeadDeliveriesForTarget.bind(this.events);
    this.getDeliveryConsumers = this.events.getDeliveryConsumers.bind(this.events);
    this.getDeliveryCountsByConsumer = this.events.getDeliveryCountsByConsumer.bind(this.events);
    this.getShadowDiffEventIds = this.events.getShadowDiffEventIds.bind(this.events);
    this.getShadowDiffEventCount = this.events.getShadowDiffEventCount.bind(this.events);
    this.pruneEventDeliveries = this.events.pruneDeliveries.bind(this.events);
  }

  private bindMfaMethods(): void {
    this.getTotp = this.mfa.getTotp.bind(this.mfa);
    this.putUnconfirmedTotp = this.mfa.putUnconfirmedTotp.bind(this.mfa);
    this.confirmTotp = this.mfa.confirmTotp.bind(this.mfa);
    this.consumeTotpStep = this.mfa.consumeTotpStep.bind(this.mfa);
    this.deleteTotp = this.mfa.deleteTotp.bind(this.mfa);
    this.replaceRecoveryCodes = this.mfa.replaceRecoveryCodes.bind(this.mfa);
    this.getUnusedRecoveryCodes = this.mfa.getUnusedRecoveryCodes.bind(this.mfa);
    this.useRecoveryCode = this.mfa.useRecoveryCode.bind(this.mfa);
    this.countRecoveryCodes = this.mfa.countRecoveryCodes.bind(this.mfa);
    this.deleteRecoveryCodes = this.mfa.deleteRecoveryCodes.bind(this.mfa);
    this.getUserIdsWithConfirmedTotp = this.mfa.getUserIdsWithConfirmedTotp.bind(this.mfa);
  }

  private bindSessionsMethods(): void {
    this.createSession = this.sessions.createSession.bind(this.sessions);
    this.getLiveSession = this.sessions.getLiveSession.bind(this.sessions);
    this.getSessionsForUser = this.sessions.getSessionsForUser.bind(this.sessions);
    this.revokeSession = this.sessions.revokeSession.bind(this.sessions);
    this.revokeUserSessions = this.sessions.revokeUserSessions.bind(this.sessions);
    this.touchSession = this.sessions.touchSession.bind(this.sessions);
    this.setSessionOrg = this.sessions.setSessionOrg.bind(this.sessions);
    this.setSessionMfaLevel = this.sessions.setSessionMfaLevel.bind(this.sessions);
    this.bumpUserSessionEpoch = this.sessions.bumpUserSessionEpoch.bind(this.sessions);
    this.getUserSessionEpoch = this.sessions.getUserSessionEpoch.bind(this.sessions);
    this.pruneSessions = this.sessions.pruneSessions.bind(this.sessions);
  }

  private bindWebhooksMethods(): void {
    this.createWebhookEndpoint = this.webhooks.createEndpoint.bind(this.webhooks);
    this.updateWebhookEndpoint = this.webhooks.updateEndpoint.bind(this.webhooks);
    this.deleteWebhookEndpoint = this.webhooks.deleteEndpoint.bind(this.webhooks);
    this.getWebhookEndpointById = this.webhooks.getEndpointById.bind(this.webhooks);
    this.getActivePageDomains = this.pageDomains.getActivePageDomains.bind(this.pageDomains);
    this.getPageDomains = this.pageDomains.getPageDomains.bind(this.pageDomains);
    this.getPageDomainsForOrg = this.pageDomains.getPageDomainsForOrg.bind(this.pageDomains);
    this.getPageDomainById = this.pageDomains.getPageDomainById.bind(this.pageDomains);
    this.getPrimaryHostnameForPage = this.pageDomains.getPrimaryHostnameForPage.bind(this.pageDomains);
    this.createPageDomain = this.pageDomains.createPageDomain.bind(this.pageDomains);
    this.updatePageDomain = this.pageDomains.updatePageDomain.bind(this.pageDomains);
    this.setPrimaryPageDomain = this.pageDomains.setPrimaryPageDomain.bind(this.pageDomains);
    this.deletePageDomain = this.pageDomains.deletePageDomain.bind(this.pageDomains);
    this.hostnameExists = this.pageDomains.hostnameExists.bind(this.pageDomains);
    this.findProbeAgentByTokenHash = this.probes.findProbeAgentByTokenHash.bind(this.probes);
    this.getAssignableRegions = this.probes.getAssignableRegions.bind(this.probes);
    this.createRegion = this.probes.createRegion.bind(this.probes);
    this.regionCodeExists = this.probes.regionCodeExists.bind(this.probes);
    this.getProbeAgents = this.probes.getProbeAgents.bind(this.probes);
    this.getProbeAgentById = this.probes.getProbeAgentById.bind(this.probes);
    this.regionHasAgent = this.probes.regionHasAgent.bind(this.probes);
    this.createProbeAgent = this.probes.createProbeAgent.bind(this.probes);
    this.updateProbeAgent = this.probes.updateProbeAgent.bind(this.probes);
    this.setProbeAgentConnection = this.probes.setProbeAgentConnection.bind(this.probes);
    this.resetProbeConnectionStates = this.probes.resetProbeConnectionStates.bind(this.probes);
    this.deleteProbeAgent = this.probes.deleteProbeAgent.bind(this.probes);
    this.getProbeAssignments = this.probes.getProbeAssignments.bind(this.probes);
    this.getProbeTargetsForMonitor = this.probes.getProbeTargetsForMonitor.bind(this.probes);
    this.createProbeAssignment = this.probes.createProbeAssignment.bind(this.probes);
    this.deleteProbeAssignment = this.probes.deleteProbeAssignment.bind(this.probes);
    this.probeAssignmentExists = this.probes.probeAssignmentExists.bind(this.probes);
    this.deleteProbeAssignmentsForMonitor = this.probes.deleteProbeAssignmentsForMonitor.bind(this.probes);
    this.getOrgById = this.orgs.getOrgById.bind(this.orgs);
    this.getOrgBySlug = this.orgs.getOrgBySlug.bind(this.orgs);
    this.getAllOrgs = this.orgs.getAllOrgs.bind(this.orgs);
    this.getOrgCounts = this.orgs.getOrgCounts.bind(this.orgs);
    this.setOrgStatus = this.orgs.setOrgStatus.bind(this.orgs);
    this.getActiveOrgIds = this.orgs.getActiveOrgIds.bind(this.orgs);
    this.getActiveOrgDomains = this.orgs.getActiveOrgDomains.bind(this.orgs);
    this.getAllOrgDomains = this.orgs.getAllOrgDomains.bind(this.orgs);
    this.getOrgsForUser = this.orgs.getOrgsForUser.bind(this.orgs);
    this.getOrgMembership = this.orgs.getOrgMembership.bind(this.orgs);
    this.isOrgMember = this.orgs.isOrgMember.bind(this.orgs);
    this.createOrg = this.orgs.createOrg.bind(this.orgs);
    this.provisionNewOrg = this.orgs.provisionNewOrg.bind(this.orgs);
    this.updateOrg = this.orgs.updateOrg.bind(this.orgs);
    this.getOrgDomainsForOrg = this.orgs.getOrgDomainsForOrg.bind(this.orgs);
    this.addOrgDomain = this.orgs.addOrgDomain.bind(this.orgs);
    this.deleteOrgDomain = this.orgs.deleteOrgDomain.bind(this.orgs);
    this.getOrgDomainByHostname = this.orgs.getOrgDomainByHostname.bind(this.orgs);
    this.addOrgMember = this.orgs.addOrgMember.bind(this.orgs);
    this.setOrgMemberOwner = this.orgs.setOrgMemberOwner.bind(this.orgs);
    this.removeOrgMember = this.orgs.removeOrgMember.bind(this.orgs);
    this.countOrgOwners = this.orgs.countOrgOwners.bind(this.orgs);
    this.getOrgMembersDetailed = this.orgs.getOrgMembersDetailed.bind(this.orgs);
    this.getWebhookEndpoints = this.webhooks.getEndpoints.bind(this.webhooks);
    this.getWebhookEndpointsCount = this.webhooks.getEndpointsCount.bind(this.webhooks);
    this.setWebhookEndpointEvents = this.webhooks.setEndpointEvents.bind(this.webhooks);
    this.getWebhookEndpointEvents = this.webhooks.getEndpointEvents.bind(this.webhooks);
    this.getActiveWebhookEndpointsForEvent = this.webhooks.getActiveEndpointsForEvent.bind(this.webhooks);
    this.recordWebhookEndpointOutcome = this.webhooks.recordEndpointOutcome.bind(this.webhooks);
    this.autoDisableWebhookEndpoint = this.webhooks.autoDisableEndpoint.bind(this.webhooks);
  }

  /**
   * The raw connection, for DDL that no repository can express (B1a).
   *
   * The only caller is `monitoring_data` partition maintenance, which issues
   * `CREATE TABLE ... PARTITION OF` against the catalogue. That is not a tenant
   * query and has no `org_id` to carry, so it neither wants nor could use
   * `BaseRepository.table()`; and it is not something to reach for otherwise,
   * which is why the name says what it is for rather than being a plain getter.
   *
   * Deliberately the worker pool: it runs from the daily scheduler, and one more
   * connection held during a `CREATE TABLE` should not come out of the budget
   * serving page loads.
   */
  knexForPartitionMaintenance(): KnexType {
    return this.workerKnex;
  }

  /** Probes database connectivity with a trivial query. Never throws. */
  async ping(): Promise<boolean> {
    try {
      await this.knex.raw("select 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.knex.destroy();
    if (this.workerKnex !== this.knex) {
      await this.workerKnex.destroy();
    }
  }
}

export default DbImpl;
