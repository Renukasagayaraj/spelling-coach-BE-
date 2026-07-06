# Mock Bee API Contract

Base idea:
- The round is session-based.
- The active challenge never exposes the target word in JSON.
- The review endpoint does expose the target word after the round is over.
- Levels 1 and 2 reveal answers immediately on submit.
- Level 3 does not reveal answers immediately.

## 1. Create Round

`POST /api/mock-bee/sessions`

Creates a new mock bee round.

Request:

```json
{
  "level": "1",
  "wordSource": "standard",
  "wordCount": 10,
  "childProfile": {
    "childId": "c1",
    "age": 8,
    "grade": "3",
    "spellingLevel": "level_1"
  }
}
```

Custom list variant:

```json
{
  "level": "2",
  "wordSource": "custom_list",
  "customListId": "list_123",
  "wordCount": 20,
  "childProfile": {
    "childId": "c1",
    "age": 10,
    "grade": "5",
    "spellingLevel": "level_2"
  }
}
```

Response:

```json
{
  "session": {
    "id": "session_id",
    "status": "active",
    "config": {
      "level": "1",
      "wordSource": "standard",
      "wordCount": 10,
      "timer": {
        "secondsPerWord": 60,
        "showCountdown": false,
        "readyPromptAtElapsedSeconds": 45,
        "revealAnswerOnSubmit": true
      }
    },
    "progress": {
      "totalWords": 10,
      "currentTurnNumber": 1,
      "answeredCount": 0,
      "correctCount": 0,
      "incorrectCount": 0,
      "timedOutCount": 0
    },
    "currentChallenge": {
      "turnIndex": 0,
      "turnNumber": 1,
      "timer": {
        "secondsPerWord": 60,
        "showCountdown": false,
        "readyPromptAtElapsedSeconds": 45,
        "revealAnswerOnSubmit": true
      },
      "supports": {
        "definition": "masked definition",
        "exampleSentence": "masked example sentence",
        "origin": "Latin",
        "partOfSpeech": "noun",
        "gradeBand": "middle",
        "difficulty": "medium",
        "level": "1"
      }
    },
    "createdAt": "iso",
    "updatedAt": "iso"
  }
}
```

UI usage:
- Store `session.id`.
- Start timer from `session.currentChallenge.timer`.
- Render support actions from `currentChallenge.supports`.
- Never expect the target word in this response.

## 2. Get Round State

`GET /api/mock-bee/sessions/:id`

Use this to restore the round after refresh or re-entry.

Response:

```json
{
  "session": {
    "id": "session_id",
    "status": "active",
    "config": {
      "level": "2",
      "wordSource": "standard",
      "wordCount": 20,
      "timer": {
        "secondsPerWord": 45,
        "showCountdown": true,
        "revealAnswerOnSubmit": true
      }
    },
    "progress": {
      "totalWords": 20,
      "currentTurnNumber": 4,
      "answeredCount": 3,
      "correctCount": 2,
      "incorrectCount": 1,
      "timedOutCount": 0
    },
    "currentChallenge": {
      "turnIndex": 3,
      "turnNumber": 4,
      "timer": {
        "secondsPerWord": 45,
        "showCountdown": true,
        "revealAnswerOnSubmit": true
      },
      "supports": {
        "definition": "masked definition",
        "exampleSentence": "masked sentence",
        "origin": "Greek",
        "partOfSpeech": "adjective",
        "gradeBand": "upper",
        "difficulty": "hard",
        "level": "2"
      }
    },
    "createdAt": "iso",
    "updatedAt": "iso"
  }
}
```

UI usage:
- If `session.status === "completed"`, navigate to review screen.
- If active, resume from `currentChallenge`.

## 3. Submit Spelling Attempt

`POST /api/mock-bee/sessions/:id/submit`

Deterministic spell check only. No live coaching shown during the round.

Request:

```json
{
  "childAttempt": "accomodate",
  "supportsUsed": {
    "definitionViewed": true,
    "exampleViewed": false,
    "originViewed": true
  }
}
```

Response:

```json
{
  "session": {
    "id": "session_id",
    "status": "active",
    "config": {
      "level": "1",
      "wordSource": "standard",
      "wordCount": 10,
      "timer": {
        "secondsPerWord": 60,
        "showCountdown": false,
        "readyPromptAtElapsedSeconds": 45,
        "revealAnswerOnSubmit": true
      }
    },
    "progress": {
      "totalWords": 10,
      "currentTurnNumber": 2,
      "answeredCount": 1,
      "correctCount": 0,
      "incorrectCount": 1,
      "timedOutCount": 0
    },
    "currentChallenge": {
      "turnIndex": 1,
      "turnNumber": 2,
      "timer": {
        "secondsPerWord": 60,
        "showCountdown": false,
        "readyPromptAtElapsedSeconds": 45,
        "revealAnswerOnSubmit": true
      },
      "supports": {
        "definition": "masked definition",
        "exampleSentence": "masked example sentence",
        "origin": "French",
        "partOfSpeech": "noun",
        "gradeBand": "middle",
        "difficulty": "medium",
        "level": "1"
      }
    },
    "createdAt": "iso",
    "updatedAt": "iso"
  },
  "result": {
    "turnIndex": 0,
    "turnNumber": 1,
    "isCorrect": false,
    "timedOut": false,
    "revealAnswer": true,
    "correctWord": "accommodate"
  }
}
```

UI usage:
- Levels 1 and 2:
  - if `result.revealAnswer === true`, may show `correctWord`
- Level 3:
  - `result.revealAnswer === false`
  - do not show answer
- Immediately move to the next challenge using returned `session.currentChallenge`

## 4. Timeout Current Word

`POST /api/mock-bee/sessions/:id/timeout`

Call this when the timer expires.

Request:

```json
{}
```

Response:

```json
{
  "session": {
    "id": "session_id",
    "status": "active",
    "config": {
      "level": "3",
      "wordSource": "standard",
      "wordCount": 10,
      "timer": {
        "secondsPerWord": 30,
        "showCountdown": true,
        "revealAnswerOnSubmit": false
      }
    },
    "progress": {
      "totalWords": 10,
      "currentTurnNumber": 6,
      "answeredCount": 5,
      "correctCount": 3,
      "incorrectCount": 1,
      "timedOutCount": 1
    },
    "currentChallenge": {
      "turnIndex": 5,
      "turnNumber": 6,
      "timer": {
        "secondsPerWord": 30,
        "showCountdown": true,
        "revealAnswerOnSubmit": false
      },
      "supports": {
        "definition": "masked definition",
        "exampleSentence": "masked sentence",
        "origin": "Latin",
        "partOfSpeech": "verb",
        "gradeBand": "upper",
        "difficulty": "hard",
        "level": "3"
      }
    },
    "createdAt": "iso",
    "updatedAt": "iso"
  },
  "result": {
    "turnIndex": 4,
    "turnNumber": 5,
    "isCorrect": false,
    "timedOut": true,
    "revealAnswer": false
  }
}
```

UI usage:
- Auto-advance to the returned next challenge.
- No answer reveal for Level 3.

## 5. Repeat / Hear The Word

`GET /api/mock-bee/sessions/:id/current-word/pronunciation`

Response:
- `200 audio/mpeg`

UI usage:
- Use this for the repeat/hear-the-word button.
- No target word is exposed to the frontend.
- If the round is already completed, endpoint returns `409`.

## 6. Get Review Data

`GET /api/mock-bee/sessions/:id/review`

Returns the end-of-round review cards. Cards may fill in progressively.

Response:

```json
{
  "review": {
    "id": "session_id",
    "status": "completed",
    "progress": {
      "totalWords": 10,
      "currentTurnNumber": 10,
      "answeredCount": 10,
      "correctCount": 6,
      "incorrectCount": 3,
      "timedOutCount": 1
    },
    "reviewStatus": {
      "not_started": 0,
      "pending": 2,
      "completed": 8,
      "failed": 0
    },
    "words": [
      {
        "turnIndex": 0,
        "turnNumber": 1,
        "word": "accommodate",
        "status": "submitted",
        "childAttempt": "accomodate",
        "isCorrect": false,
        "reviewCardStatus": "completed",
        "reviewCard": {
          "correctness": {},
          "missAnalysis": {},
          "wordTeaching": {},
          "errorRelevance": {},
          "teachingDecision": {},
          "coachingText": {},
          "wordBreakdown": {},
          "conceptLabels": {},
          "nextStep": {}
        },
        "reviewError": null,
        "supports": {
          "definition": "masked definition",
          "exampleSentence": "masked sentence",
          "origin": "Latin",
          "partOfSpeech": "verb",
          "gradeBand": "upper",
          "difficulty": "hard",
          "level": "2"
        }
      }
    ]
  }
}
```

UI usage:
- This is where the actual `word` is allowed to appear.
- Each row/card can be a collapsible item.
- Use `reviewCardStatus` for progressive rendering:
  - `pending` -> loading state
  - `completed` -> render card
  - `failed` -> show fallback or error
- Poll until `reviewStatus.pending === 0` if needed.

## Level Rules For UI

- Level 1:
  - `60s`
  - no visible countdown
  - at `45s` elapsed, UI can show `Ready to spell?`
  - reveal answer on submit
- Level 2:
  - `45s`
  - visible countdown
  - reveal answer on submit
- Level 3:
  - `30s`
  - visible countdown
  - do not reveal answer on submit

## Recommended UI Flow

1. User selects:
   - level
   - source: standard or custom list
   - word count: 10, 20, or 30
2. UI calls `POST /api/mock-bee/sessions`
3. UI renders `currentChallenge.supports`
4. Repeat button uses the pronunciation endpoint
5. Submit button uses `/submit`
6. Timer expiry uses `/timeout`
7. When `session.status === "completed"`, navigate to review screen
8. Review screen polls `/review` until cards are populated

## Error Handling

- `401`
  - auth missing or invalid for custom-list rounds
- `403`
  - session does not belong to current user
- `404`
  - unknown session
  - unknown custom list
- `409`
  - round already completed
  - requested current-word pronunciation after round end
