DX ARRANGER FOR ANDROID
=======================
The same panel as the Windows app with the engine built in: no Python, no server, no FluidSynth, works offline.
Drums only, like the Windows app.

GET THE APP (GitHub builds it for you, you do not need Android Studio)
  1. Upload this package to your GitHub repo (see UPLOAD at the bottom).
  2. Open the repo > Actions > "Build Android APK". It takes about 8-12 minutes. Green tick = done.
  3. Get the APK on your phone, either way:
       - Releases (right side of the repo page) > "DX Arranger for Android (latest)" > DX-Arranger.apk    (easiest)
       - or open the finished run > Artifacts > DX-Arranger-Android (a zip with the APK inside)
  4. Open DX-Arranger.apk to install. Android asks you to allow "install unknown apps" for the browser or Files app you
     used: allow it once. Turn the phone sideways (landscape): the panel is wide.
  If the run shows a red cross, open it and send a photo of the red error line.

FIRST USE
  - Tap once anywhere: Android only allows sound after a touch.
  - ADD STYLES:  press a P button (P1-P16), choose the first entry "+ ADD STYLES", press ENTER, pick .STY files from the
    phone. They are stored inside the app and stay after you close it. Choose a style, ENTER, then START.
    (MENU > STYLES > INBUILT also imports a style and loads it at once.)
  - Changing style while playing does not stop the beat: the new style takes over at the next bar at the same tempo.
  - MULTI PADS:  MENU > STYLES > MULTIPAD > "+ ADD FILES" (.wav .mp3 .pad .mid). While the list is open P1-P4 choose the
    target pad (and play it); ENTER loads the highlighted file onto it. Pads loop until you press them again or press STOP.
    STOP stops the beat and every pad. Audio samples loop seamlessly; MIDI pads follow the tempo exactly and start on the
    style's next beat. Percussion (shakers, tambourine...) in a .pad file plays as drums, not as notes.
  - EFFECTS:  MENU > EFFECTS: Graphic EQ, EQ3-M, EZ EQ, Studio Reverb, Spring Reverb, BL Drive. Each has its own ON/OFF and
    there is ALL EFFECTS OFF. On the phone these are real audio effects (filters, reverb, saturation).
  - SOUND:  MENU > SETTINGS:
        LOAD SOUNDFONT (.SF2)   load GeneralUser-GS.sf2 (or any .sf2 with a drum kit) for richer drums. It is stored in
                                the app; loading takes a few seconds.
        USE BUILT-IN SOUNDS     back to the app's own synthesized drums (used until you load a SoundFont)
        SHAKER LEVEL            100 / 80 / 60 / 40 / 20 %  (default 60% = soft)
        HI-HAT FEEL             on/off: beat strongest, 16ths softest
        PAD LOOP                on/off

GOOD TO KNOW
  - Keep the app open while you play: Android pauses web audio when an app goes to the background.
  - The APK is a debug build signed with Android's debug key: fine for your own phone, not for the Play Store.
  - The panel uses the JetBrains Mono font from Google Fonts when online and a plain monospace font when offline.
  - Tested: the engine (styles, fills, tempo, style change, pads, effects, SoundFont) in a real browser with real Web Audio.
    NOT tested: the Android build itself and the sound on a phone (they need GitHub's build and a phone).

UPLOAD (GitHub)
  Put these in the repo, keeping the folders:
     android-app/    (the whole folder: make_android.py, package.json, capacitor.config.json, README, src/ with 3 files)
     .github/workflows/build-android.yml
  If the web page will not take the hidden .github folder: Add file > Create new file, type the name
  .github/workflows/build-android.yml and paste the contents of build-android.yml.
  The Windows files can stay or go: this build does not use them. To stop the Windows build from running on every push
  for now: Actions > "Build Windows app" > the three dots > Disable workflow (you can enable it again later).
