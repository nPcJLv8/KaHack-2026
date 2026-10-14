# KaHack! (2026 rebuild)

A Tampermonkey userscript for [kahoot.it](https://kahoot.it) that shows or automatically answers questions. It's a rebuild of [jokeri2222/KaHack](https://github.com/jokeri2222/KaHack) for the current Kahoot player.

## Answer sources

The script tries these in order, fastest first:

| Source | Speed | Accuracy | Works on |
|---|---|---|---|
| **Quiz match**: a quiz loaded by ID, URL or title search | instant | exact | public quizzes |
| **Remembered**: answers saved from earlier quiz matches | instant | exact | questions you've seen before |
| **Auto-detect**: searches public quizzes for the on-screen question text, once per game | ~0.5–1 s | exact | public quizzes |
| **Claude AI**: reads the question and answers from the screen | ~0.5–1.5 s | usually right; labelled "AI guess" | any quiz, including private ones |

Answers are matched by their text, so shuffled answer order doesn't matter. Auto answer waits for a pending quiz match before it clicks an AI guess.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script, paste in [`KaHack.user.js`](KaHack.user.js), and save.
3. Open kahoot.it. When Tampermonkey asks for permission to connect to `create.kahoot.it` and `api.anthropic.com`, choose **Always allow**.

## Use

- **Show answers** puts a green outline on the correct answers and fades the wrong ones.
- **Auto answer** clicks the correct answer for you, including multi-select plus Submit. The **target points** slider sets how long it waits before clicking: 1000 clicks instantly, 500 waits until the very end.
- **Quiz** section: paste a quiz ID or URL, or type a title and press Enter. You can also leave auto-detect on and skip this.
- **AI fallback** section: paste an Anthropic API key. The key is kept in Tampermonkey's private storage, where kahoot.it's own scripts can't read it. Pick **Haiku 5.5** if you want the fastest answers.
- Alt+H hides the panel and Alt+X closes it.

## Limitations

- Kahoot never sends correct answers to a player's device, so there's no fully instant mode for private quizzes.
- If the host hides question and answer text on players' screens, the AI and auto-detect can't work. Only a quiz loaded by ID will.
- Image-only answers, type-answer, slider and puzzle questions only get answers from a quiz match.
