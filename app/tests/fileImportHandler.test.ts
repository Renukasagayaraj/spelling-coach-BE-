import assert from "node:assert/strict";
import test from "node:test";

process.env.SUPABASE_URL = "https://file-import-test.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY = "file-import-test-key";

const { FileImportRequestError, extractWordsFromFile, validateFile } = await import("../fileImportHandler.js");
const { importCustomWords } = await import("../customWordImport.js");

test("file import validation accepts text formats and rejects unsupported files", () => {
  assert.equal(validateFile("words.TXT", "text/plain", Buffer.from("friend")), ".txt");
  assert.equal(validateFile("words.csv", "text/csv; charset=utf-8", Buffer.from("word\nfriend")), ".csv");

  assert.throws(
    () => validateFile("words.pdf", "application/pdf", Buffer.from("friend")),
    (error: unknown) => error instanceof FileImportRequestError && error.statusCode === 415 && /Only \.txt and \.csv/.test(error.message),
  );
  assert.throws(
    () => validateFile("words.txt", "application/pdf", Buffer.from("friend")),
    (error: unknown) => error instanceof FileImportRequestError && error.statusCode === 415,
  );
  assert.throws(
    () => validateFile("words.txt", "text/plain", Buffer.alloc(0)),
    (error: unknown) => error instanceof FileImportRequestError && error.statusCode === 422 && /empty/.test(error.message),
  );
  assert.throws(
    () => validateFile("words.txt", "text/plain", Buffer.alloc(1024 * 1024 + 1)),
    (error: unknown) => error instanceof FileImportRequestError && error.statusCode === 413,
  );
});

test("validateFile rejects a file with no extension", () => {
  assert.throws(
    () => validateFile("words", "text/plain", Buffer.from("hello")),
    (error: unknown) => error instanceof FileImportRequestError && error.statusCode === 415 && /\(none\)/.test(error.message),
  );
});

test("validateFile accepts files without a content-type header", () => {
  assert.equal(validateFile("words.txt", undefined, Buffer.from("hello")), ".txt");
  assert.equal(validateFile("words.csv", undefined, Buffer.from("word\nhello")), ".csv");
});

test("validateFile rejects a file containing null bytes (binary / corrupted)", () => {
  const corruptBuffer = Buffer.from([104, 101, 108, 0, 108, 111]);
  assert.throws(
    () => validateFile("words.txt", "text/plain", corruptBuffer),
    (error: unknown) => error instanceof FileImportRequestError && error.statusCode === 422 && /not a valid text/.test(error.message),
  );
});

test("validateFile accepts a file exactly at the size limit", () => {
  const maxBuffer = Buffer.alloc(1024 * 1024, "a".charCodeAt(0));
  assert.equal(validateFile("words.txt", "text/plain", maxBuffer), ".txt");
});

test("validateFile rejects application/pdf MIME for .csv extension", () => {
  assert.throws(
    () => validateFile("words.csv", "application/pdf", Buffer.from("word\nhello")),
    (error: unknown) => error instanceof FileImportRequestError && error.statusCode === 415,
  );
});

test("file parsing deduplicates case-insensitively and handles CSV headers and quotes", () => {
  assert.deepEqual(
    extractWordsFromFile("Friend\nfriend\nSCHOOL\n", ".txt"),
    ["Friend", "SCHOOL"],
  );
  assert.deepEqual(
    extractWordsFromFile('word,definition\n"friend","a companion"\n"school","a place"\nFRIEND,duplicate', ".csv"),
    ["friend", "school"],
  );
});

test("extractWordsFromFile ignores blank and whitespace-only lines in .txt files", () => {
  const content = "friend\n\n   \nschool\n\t\nrhythm";
  assert.deepEqual(extractWordsFromFile(content, ".txt"), ["friend", "school", "rhythm"]);
});

test("extractWordsFromFile ignores blank and whitespace-only rows in .csv files", () => {
  const content = "word\nfriend\n\n   \nschool\n";
  assert.deepEqual(extractWordsFromFile(content, ".csv"), ["friend", "school"]);
});

test("extractWordsFromFile handles mixed-case duplicates within the file", () => {
  const content = "Apple\napple\nAPPLE\nbanana\nBANANA\n";
  const words = extractWordsFromFile(content, ".txt");
  assert.deepEqual(words, ["Apple", "banana"]);
});

test("extractWordsFromFile handles Unicode words correctly", () => {
  const content = "naïve\ncafé\nrésumé\nnaïve\n";
  const words = extractWordsFromFile(content, ".txt");
  assert.deepEqual(words, ["naïve", "café", "résumé"]);
});

test("extractWordsFromFile handles comma and tab-delimited .txt files", () => {
  const content = "friend,school\nrhythm\tmusic\n";
  const words = extractWordsFromFile(content, ".txt");
  assert.deepEqual(words, ["friend", "school", "rhythm", "music"]);
});

test("extractWordsFromFile strips surrounding quotes and trims whitespace from CSV first-column words", () => {
  const content = '"apple"\n"  banana  "\n"cherry"\n';
  const words = extractWordsFromFile(content, ".csv");
  assert.deepEqual(words, ["apple", "banana", "cherry"]);
});

test("extractWordsFromFile handles a CSV file with no header row", () => {
  const content = "friend\nschool\nrhythm\n";
  assert.deepEqual(extractWordsFromFile(content, ".csv"), ["friend", "school", "rhythm"]);
});

test("extractWordsFromFile handles CRLF line endings in .txt files", () => {
  const content = "friend\r\nschool\r\nrhythm\r\n";
  assert.deepEqual(extractWordsFromFile(content, ".txt"), ["friend", "school", "rhythm"]);
});

test("extractWordsFromFile handles CR-only line endings in .csv files", () => {
  const content = "word\rfriend\rschool\r";
  assert.deepEqual(extractWordsFromFile(content, ".csv"), ["friend", "school"]);
});

test("extractWordsFromFile returns an empty array for a file that is only whitespace", () => {
  assert.deepEqual(extractWordsFromFile("   \n\n\t  \n", ".txt"), []);
  assert.deepEqual(extractWordsFromFile("word\n   \n\n", ".csv"), []);
});

test("custom import keeps existing words while deduplicating appended words", async () => {
  const existingWord = {
    word: "friend",
    level: "custom" as const,
    grade_band: "custom",
    difficulty: "custom",
    origin: "English",
    definition: "A companion.",
    example_sentence: "A friend helped.",
    patterns: [],
    common_mistakes: [],
    coach_tip: "",
    part_of_speech: "noun",
  };
  const existingList = {
    id: "existing-list",
    name: "Weekly Words",
    owner_user_id: "user-1",
    words: [existingWord],
  };

  const result = await importCustomWords(
    {
      listId: existingList.id,
      listName: existingList.name,
      words: ["Friend", "school", "SCHOOL"],
      overwriteList: false,
    },
    {
      ownerUserId: "user-1",
      existingList,
      skipFileSave: true,
      generateMetadata: async (words) => words.map((word) => ({
        word,
        definition: "A place for learning.",
        origin: "Greek",
        exampleSentence: "The school opened.",
        partOfSpeech: "noun",
      })),
    },
  );

  assert.equal(result.importedCount, 1);
  assert.equal(result.skippedExistingCount, 1);
  assert.deepEqual(result.words.map((entry) => entry.word), ["school"]);
  assert.deepEqual(result.listWords.map((entry) => entry.word), ["friend", "school"]);
});

test("custom import with overwriteList replaces all existing words", async () => {
  const existingWord = {
    word: "old",
    level: "custom" as const,
    grade_band: "custom",
    difficulty: "custom",
    origin: "English",
    definition: "Something old.",
    example_sentence: "That is old.",
    patterns: [],
    common_mistakes: [],
    coach_tip: "",
    part_of_speech: "adjective",
  };
  const existingList = {
    id: "overwrite-list",
    name: "Overwrite Test",
    owner_user_id: "user-2",
    words: [existingWord],
  };

  const result = await importCustomWords(
    {
      listId: existingList.id,
      listName: existingList.name,
      words: ["friend", "school"],
      overwriteList: true,
    },
    {
      ownerUserId: "user-2",
      existingList,
      skipFileSave: true,
      generateMetadata: async (words) => words.map((word) => ({
        word,
        definition: "Definition.",
        origin: "English",
        exampleSentence: "Sentence.",
        partOfSpeech: "noun",
      })),
    },
  );

  assert.equal(result.importedCount, 2);
  assert.equal(result.skippedExistingCount, 0);
  assert.deepEqual(result.listWords.map((e) => e.word), ["friend", "school"]);
});

test("custom import deduplicates mixed-case words in the incoming list", async () => {
  const result = await importCustomWords(
    {
      listName: "Dedup Test",
      words: ["Apple", "apple", "APPLE", "Banana"],
      overwriteList: true,
    },
    {
      ownerUserId: "user-dedup",
      skipFileSave: true,
      generateMetadata: async (words) => words.map((word) => ({
        word,
        definition: "A fruit.",
        origin: "English",
        exampleSentence: `I ate a ${word}.`,
        partOfSpeech: "noun",
      })),
    },
  );

  assert.equal(result.importedCount, 2);
  assert.deepEqual(result.listWords.map((e) => e.word.toLowerCase()), ["apple", "banana"]);
});
