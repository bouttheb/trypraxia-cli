import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Materialize durable project source files and files attached only to the
 * current turn. Agents receive local paths instead of large base64 prompts.
 */
export async function materializeProjectFiles(command, options = {}) {
  const saved = Array.isArray(command.project_context_files) ? command.project_context_files : [];
  const current = Array.isArray(command.room_attachments) ? command.room_attachments : [];
  if (saved.length === 0 && current.length === 0) return null;

  const dir = mkdtempSync(join(tmpdir(), `praxia-room-${command.id}-`));
  const usedAttachmentIds = new Set();
  command.project_context_file_paths = await materializeGroup(saved, "source", dir, usedAttachmentIds, options);
  command.room_attachment_paths = await materializeGroup(current, "turn", dir, usedAttachmentIds, options);

  if (command.project_context_file_paths.length || command.room_attachment_paths.length) return dir;
  rmSync(dir, { recursive: true, force: true });
  return null;
}

async function materializeGroup(attachments, prefix, dir, usedAttachmentIds, options) {
  const paths = [];
  for (const [index, attachment] of attachments.entries()) {
    if (!attachment || typeof attachment !== "object") continue;
    const attachmentId = Number(attachment.id);
    if (Number.isFinite(attachmentId) && usedAttachmentIds.has(attachmentId)) continue;
    const safeName =
      String(attachment.name || `attachment-${index + 1}`)
        .replace(/[^A-Za-z0-9._ -]+/g, "_")
        .slice(0, 120) || `attachment-${index + 1}`;
    const filePath = join(dir, `${prefix}-${index + 1}-${safeName}`);
    try {
      if (typeof attachment.data_base64 === "string" && attachment.data_base64) {
        writeFileSync(filePath, Buffer.from(attachment.data_base64, "base64"));
      } else if (typeof attachment.download_url === "string" && typeof options.download === "function") {
        const downloaded = await options.download(attachment);
        if (!downloaded || downloaded.length === 0) throw new Error("download returned no content");
        writeFileSync(filePath, downloaded);
      } else if (typeof attachment.content_text === "string") {
        writeFileSync(filePath, attachment.content_text, "utf8");
      } else {
        continue;
      }
      if (Number.isFinite(attachmentId)) usedAttachmentIds.add(attachmentId);
      paths.push({
        id: Number.isFinite(attachmentId) ? attachmentId : null,
        name: attachment.name || safeName,
        path: filePath,
        media_type: attachment.media_type || "application/octet-stream",
        trust_level: attachment.trust_level || "untrusted_external",
      });
    } catch (error) {
      // A single malformed attachment must not strand the entire command.
      if (typeof options.onError === "function") options.onError(attachment, error);
    }
  }
  return paths;
}
