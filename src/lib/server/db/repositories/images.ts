import { BaseRepository } from "./base.js";
import type { ImageRecord, ImageRecordInsert } from "../../types/db.js";

/**
 * Repository for images operations
 */
export class ImagesRepository extends BaseRepository {
  async insertImage(data: ImageRecordInsert): Promise<string> {
<<<<<<< HEAD
    await this.table("images").insert(data);
=======
    // MySQL compiles ignore() to INSERT IGNORE, which stores over-long data cut short instead of failing.
    await this.knex("images").insert(data).onConflict("id").merge(["id"]);
>>>>>>> 6dec4f71aeb8dfb845303b0363f42ca38019e959
    return data.id;
  }

  async getImageById(id: string): Promise<ImageRecord | undefined> {
    return await this.table("images").where("id", id).first();
  }

  async deleteImage(id: string): Promise<number> {
    return await this.table("images").where("id", id).del();
  }

  async getAllImages(): Promise<ImageRecord[]> {
    return await this.table("images")
      .select("id", "mime_type", "original_name", "width", "height", "size", "created_at")
      .orderBy("created_at", "desc");
  }
}
