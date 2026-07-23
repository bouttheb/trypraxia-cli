import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Materialize durable project source files and files attached only to the
 * current turn. Agents receive local paths instead of large base64 prompts.
 */
export function materializeProjectFiles(command) {
  const saved = Array.isArray(command.project_context_files) ? command.project_context_files : [];
  const current = Array.isArray(command.room_attachments) ? command.room_attachments : [];
  if (saved.length === 0 && current.length === 0) return null;

  const dir = mkdtempSync(join(tmpdir(), `praxia-room-${command.id}-`));
  const usedAttachmentIds = new Set();
  command.project_context_file_paths = materializeGroup(saved, "source", dir, usedAttachmentIds);
  command.room_attachment_paths = materializeGroup(current, "turn", dir, usedAttachmentIds);

  if (command.project_context_file_paths.length || command.room_attachment_paths.length) return dir;
  rmSync(dir, { recursive: true, force: true });
  return null;
}

function materializeGroup(attachments, prefix, dir, usedAttachmentIds) {
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
    } catch {
      // A single malformed attachment must not strand the entire command.
    }
  }
  return paths;
}
