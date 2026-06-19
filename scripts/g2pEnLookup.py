#!/usr/bin/env python3

import json
import sys


def main() -> int:
    try:
        import nltk
        from g2p_en import G2p
    except Exception as exc:  # pragma: no cover - runtime dependency guard
        sys.stderr.write(f"Failed to import g2p_en: {exc}\n")
        return 1

    for resource, path in [
        ("averaged_perceptron_tagger_eng", "taggers/averaged_perceptron_tagger_eng"),
        ("averaged_perceptron_tagger", "taggers/averaged_perceptron_tagger"),
        ("cmudict", "corpora/cmudict"),
    ]:
        try:
            nltk.data.find(path)
        except LookupError:
            nltk.download(resource, quiet=True)

    try:
        words = json.load(sys.stdin)
    except Exception as exc:
        sys.stderr.write(f"Failed to parse stdin JSON: {exc}\n")
        return 1

    if not isinstance(words, list):
        sys.stderr.write("Expected a JSON array of words on stdin.\n")
        return 1

    g2p = G2p()
    result = {}

    for raw_word in words:
        if not isinstance(raw_word, str):
            continue

        word = raw_word.strip()
        if not word:
            continue

        tokens = [
            token
            for token in g2p(word)
            if isinstance(token, str) and token.strip() and token != " "
        ]
        result[word.lower()] = tokens

    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
