import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";

import type { AuthenticatedUser } from "./auth.js";
import { importCustomWords } from "./customWordImport.js";
import {
  fetchCustomListByIdFromDB,
  saveCustomListToDB,
  type DBCustomList,
} from "./supabase.js";
import { buildWordResponse } from "./inputBuilder.js";

const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MB
export const MAX_IMPORT_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024;
const ALLOWED_EXTENSIONS = new Set([".txt", ".csv"]);
const ALLOWED_CONTENT_TYPES: Record<string, Set<string>> = {
  ".txt": new Set(["text/plain", "application/octet-stream"]),
  ".csv": new Set(["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain", "application/octet-stream"]),
};
const JOB_TTL_MS = 30 * 60 * 1000; // purge completed jobs after 30 minutes

interface ParsedMultipartField {
  fieldName: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export type ImportJob =
  | { status: "processing"; filename: string; detectedWords: number; startedAt: number }
  | { status: "done"; result: unknown; completedAt: number }
  | { status: "failed"; error: string; completedAt: number };

type StoredImportJob = ImportJob & { ownerUserId: string };

export class FileImportRequestError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "FileImportRequestError";
  }
}

const jobs = new Map<string, StoredImportJob>();

function generateJobId(): string {
  return randomUUID();
}

function purgeOldJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    const timestamp = job.status === "processing" ? job.startedAt : job.completedAt;
    if (timestamp < cutoff) {
      jobs.delete(id);
    }
  }
}

export function getImportJob(jobId: string, ownerUserId: string): ImportJob | undefined {
  const job = jobs.get(jobId);
  if (!job || job.ownerUserId !== ownerUserId) return undefined;
  const { ownerUserId: _ownerUserId, ...publicJob } = job;
  return publicJob;
}

function parseMultipart(body: Buffer, boundary: string): ParsedMultipartField[] {
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const CRLF = Buffer.from("\r\n");
  const DOUBLE_CRLF = Buffer.from("\r\n\r\n");

  const fields: ParsedMultipartField[] = [];
  let searchStart = 0;
  const parts: Buffer[] = [];

  while (true) {
    const idx = body.indexOf(boundaryBuf, searchStart);
    if (idx === -1) break;

    const afterBoundary = idx + boundaryBuf.length;
    if (body.slice(afterBoundary, afterBoundary + 2).toString() === "--") break;

    const partStart = afterBoundary + CRLF.length;
    const nextBoundary = body.indexOf(boundaryBuf, partStart);
    if (nextBoundary === -1) break;

    const partEnd = nextBoundary - CRLF.length;
    parts.push(body.slice(partStart, partEnd));
    searchStart = nextBoundary;
  }

  for (const part of parts) {
    const headerEnd = part.indexOf(DOUBLE_CRLF);
    if (headerEnd === -1) continue;

    const headerSection = part.slice(0, headerEnd).toString("latin1");
    const data = part.slice(headerEnd + DOUBLE_CRLF.length);

    const dispositionMatch = headerSection.match(
      /Content-Disposition:\s*form-data;([^\r\n]*)/i,
    );
    if (!dispositionMatch) continue;

    const disposition = dispositionMatch[1];
    const nameMatch = disposition.match(/name="([^"]+)"/i);
    const filenameMatch = disposition.match(/filename="([^"]*)"/i);

    if (!nameMatch) continue;

    const fieldName = nameMatch[1];
    const filename = filenameMatch?.[1];
    const ctMatch = headerSection.match(/Content-Type:\s*([^\r\n]+)/i);
    const contentType = ctMatch?.[1]?.trim();

    fields.push({ fieldName, filename, contentType, data });
  }

  return fields;
}

export function extractWordsFromFile(content: string, extension: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const seen = new Set<string>();
  const words: string[] = [];

  const addWord = (raw: string) => {
    const w = raw.trim().replace(/^["']|["']$/g, "").trim();
    if (!w) return;
    const key = w.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      words.push(w);
    }
  };

  if (extension === ".csv") {
    let startRow = 0;
    const firstCell = splitCsvRow(lines[0] ?? "")[0]?.trim().toLowerCase() ?? "";
    if (["word", "words", "spelling word", "spelling words", "vocabulary"].includes(firstCell)) {
      startRow = 1;
    }
    for (let i = startRow; i < lines.length; i++) {
      const cells = splitCsvRow(lines[i]);
      if (cells.length === 0) continue;
      addWord(cells[0] ?? "");
    }
  } else {
    for (const line of lines) {
      const stripped = line.trim();
      if (!stripped) continue;
      if (stripped.includes(",") || stripped.includes("\t")) {
        const parts = stripped.split(/[,\t]/);
        for (const part of parts) addWord(part);
      } else {
        addWord(stripped);
      }
    }
  }

  return words;
}

function splitCsvRow(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  cells.push(current);
  return cells;
}

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

export function validateFile(filename: string, contentType: string | undefined, data: Buffer): string {
  const ext = getExtension(filename);

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new FileImportRequestError(
      `Unsupported file type "${ext || "(none)"}". Only .txt and .csv files are accepted.`,
      415,
    );
  }

  const normalizedContentType = contentType?.split(";", 1)[0].trim().toLowerCase();
  if (normalizedContentType && !ALLOWED_CONTENT_TYPES[ext].has(normalizedContentType)) {
    throw new FileImportRequestError(
      `The uploaded file has an unsupported content type (${normalizedContentType}). Only .txt and .csv files are accepted.`,
      415,
    );
  }

  if (data.length === 0) {
    throw new FileImportRequestError("The uploaded file is empty.", 422);
  }

  if (data.length > MAX_FILE_BYTES) {
    throw new FileImportRequestError("File size exceeds the 1\u202fMB limit.", 413);
  }

  if (data.includes(0)) {
    throw new FileImportRequestError("The uploaded file is not a valid text file.", 422);
  }

  return ext;
}

async function runImportJob(
  jobId: string,
  authHeader: string,
  userId: string,
  listName: string,
  words: string[],
  listId: string | undefined,
  overwriteList: boolean,
): Promise<void> {
  try {
    let existingList: DBCustomList | undefined;
    if (listId) {
      const dbList = await fetchCustomListByIdFromDB(authHeader, listId, userId);
      if (dbList) existingList = dbList;
    }

    const importResult = await importCustomWords(
      { listName, words, overwriteList, listId },
      { ownerUserId: userId, existingList, skipFileSave: true },
    );

    const savedList = await saveCustomListToDB(
      authHeader,
      userId,
      listName,
      importResult.listWords,
      listId || importResult.list.id,
    );

    jobs.set(jobId, {
      ownerUserId: userId,
      status: "done",
      completedAt: Date.now(),
      result: {
        list: {
          id: savedList.id,
          name: savedList.name,
          wordCount: savedList.words.length,
        },
        importedCount: importResult.importedCount,
        skippedExistingCount: importResult.skippedExistingCount,
        words: importResult.words.map((word) => buildWordResponse(word)),
      },
    });
  } catch (error) {
    jobs.set(jobId, {
      ownerUserId: userId,
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error during import.",
      completedAt: Date.now(),
    });
  }
}

export async function handleImportFileRequest(
  request: IncomingMessage,
  rawBody: Buffer,
  user: AuthenticatedUser,
): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";

  if (!/^multipart\/form-data(?:;|$)/i.test(contentType.trim())) {
    throw new FileImportRequestError(
      'Expected a multipart/form-data request. Use a <form> or FormData to upload your file.',
      415,
    );
  }

  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/i);
  if (!boundaryMatch) {
    throw new FileImportRequestError("multipart/form-data boundary is missing from Content-Type header.");
  }

  const boundary = boundaryMatch[1].replace(/^"|"$/g, "");
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) {
    throw new FileImportRequestError("multipart/form-data boundary is invalid.");
  }
  const fields = parseMultipart(rawBody, boundary);

  const getTextField = (name: string): string | undefined => {
    const f = fields.find((f) => f.fieldName === name && !f.filename);
    return f ? f.data.toString("utf8").trim() : undefined;
  };

  const fileField = fields.find((f) => f.fieldName === "file" && f.filename);
  if (!fileField) {
    throw new FileImportRequestError(
      'No file field found in the request. Send the file in a form field named "file".',
    );
  }

  const originalFilename = fileField.filename!;
  const ext = validateFile(originalFilename, fileField.contentType, fileField.data);
  let fileText: string;
  try {
    fileText = new TextDecoder("utf-8", { fatal: true }).decode(fileField.data);
  } catch {
    throw new FileImportRequestError("The uploaded file must contain valid UTF-8 text.", 422);
  }
  const words = extractWordsFromFile(fileText, ext);

  if (words.length === 0) {
    throw new FileImportRequestError(
      "No words could be extracted from the uploaded file. Make sure each line contains a word.",
      422,
    );
  }

  const rawListName = getTextField("listName");
  const listName =
    rawListName ||
    originalFilename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() ||
    "Imported List";
  if (listName.length > 100) {
    throw new FileImportRequestError("List name must be 100 characters or fewer.", 422);
  }

  const listId = getTextField("listId") || undefined;
  const rawOverwriteList = getTextField("overwriteList");
  if (rawOverwriteList && rawOverwriteList !== "true" && rawOverwriteList !== "false") {
    throw new FileImportRequestError('overwriteList must be either "true" or "false".', 422);
  }
  const overwriteList = rawOverwriteList === "true";
  const authHeader = request.headers.authorization || "";

  const jobId = generateJobId();

  jobs.set(jobId, {
    ownerUserId: user.id,
    status: "processing",
    filename: originalFilename,
    detectedWords: words.length,
    startedAt: Date.now(),
  });

  void runImportJob(jobId, authHeader, user.id, listName, words, listId, overwriteList);

  purgeOldJobs();

  return {
    status: "processing_in_background",
    jobId,
    listId,
    listName,
    detectedWords: words.length,
    filename: originalFilename,
  };
}
