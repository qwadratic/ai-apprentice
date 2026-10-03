# Third-party notices

## Clicky (MIT)

Apprentice is a new code base. Its overlay, menu-bar and permission plumbing follows patterns studied in
[Clicky](https://github.com/farzaa/clicky) by Farza: a click-through, non-activating overlay panel per screen
(`.screenSaver` level, `canJoinAllSpaces` + `fullScreenAuxiliary`, `hidesOnDeactivate = false`, `canBecomeKey = false`),
an accessory app with an `NSStatusItem`, ScreenCaptureKit screenshots that exclude the app's own windows,
the `AVAudioEngine` to `SFSpeechAudioBufferRecognitionRequest` dictation setup, and the ElevenLabs text-to-speech
request shape. No Clicky source file is copied verbatim; the notice is kept anyway because the structure is adapted.

Clicky's license:

```
MIT License

Copyright (c) 2026 Farza

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
