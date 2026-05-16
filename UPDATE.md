# How to update the app

When the developer ships fixes or new features, you'll need to download the new version of the project files. Your saved data (API keys, channels, transcripts, chat history, etc.) is kept separately in a folder called `data/` and **does not get touched** during an update — as long as you follow the steps below.

This guide assumes you've **never written code, never used a terminal, never used GitHub**. Every step is spelled out. Take your time — a normal update takes 5-10 minutes.

> **If anything looks weird or doesn't match what's on your screen, STOP and screenshot it.** Send the screenshot to the developer with a short note saying which step you're on. Don't guess — most steps are reversible, but one wrong move when copying the `data` folder could lose your settings.

---

## Before you start — fix the OneDrive problem (if it applies to you)

Open the folder where your project currently lives. **If the path contains `OneDrive`, `iCloud Drive`, `Dropbox`, or `Google Drive`** — you need to move it before doing anything else.

**Why this matters:** cloud-sync services constantly copy file changes to the internet. The app uses a database file (called `app.db`) that gets touched many times per minute while the app is running. Sync services can grab the file at a bad moment and corrupt it — and then your API keys, your transcripts, your chat history are gone. The app will look empty even though you set it up correctly.

**How to fix:**

1. Make sure the app is **not running** (close any `start.bat` terminal window).
2. Open **File Explorer** (yellow folder icon on the taskbar).
3. Find your current project folder. Likely path: `OneDrive\Desktop\Eric-yt-channel-ai-main` or similar.
4. Pick a new safe home for it. Good options:
   - `C:\Eric-yt-channel-ai` (right at the root of your C: drive — this is never synced)
   - `C:\Users\<your-name>\Documents\Eric-yt-channel-ai` (only if your `Documents` folder does NOT show a small cloud icon next to it; if it does, use the first option)
5. **Drag the entire project folder** from its current location to the new location.
6. Done. From now on, run `install.bat` and `start.bat` from the new location, not the old one.

If your project is already outside of any synced folder, you can skip this section.

---

## Which update path is yours?

There are two ways people first installed the app. Figure out which is yours so you follow the right section:

- **Did you download a ZIP file from GitHub** (or get one from the developer), unzip it, and run `install.bat` / `start.bat` from inside that folder? → **Use Path A: ZIP update** below.
- **Did you install "GitHub Desktop"** and clone the project through it? → **Use Path B: GitHub Desktop update** below.
- **Not sure?** Look inside your project folder. If you see a hidden folder called `.git` (you may need to enable "Show hidden items" in File Explorer's View menu), you're on Path B. If not, you're on Path A.

---

## Path A — Update via fresh ZIP download (no extra tools needed)

This is the simpler path on the day-of, but you have to repeat it every time. If you find yourself updating more than once or twice, please read the **"Switch to GitHub Desktop"** section at the very bottom of this guide — it makes future updates one-click.

### Step 1. Stop the app

If the app is currently running, you'll see a **black terminal window** somewhere on your screen — it was opened when you double-clicked `start.bat`. **Close that terminal window** (click the X in its top-right corner). The app's server is now off.

You can leave the browser tab open — the app's webpage will just say "site can't be reached" once the server stops. That's expected.

### Step 2. Rename your current project folder

We're keeping the old folder around for a few minutes — there's one folder inside it that we need to copy over.

1. Open **File Explorer**.
2. Navigate to where your project folder lives.
3. Right-click on the project folder (e.g. `Eric-yt-channel-ai-main`) → **Rename**.
4. Add `-old` to the end of the name. Example: `Eric-yt-channel-ai-main` becomes `Eric-yt-channel-ai-main-old`.
5. Press **Enter** to confirm.

### Step 3. Download the new ZIP

1. Open this link in your web browser:
   **[https://github.com/Bander4ik/Eric-yt-channel-ai](https://github.com/Bander4ik/Eric-yt-channel-ai)**
2. Above the file list near the top of the page, find the **green `<> Code` button** and click it.
3. In the dropdown menu that opens, click **Download ZIP** (at the bottom).
4. A ZIP file starts downloading. It will be named `Eric-yt-channel-ai-main.zip` and lands in your **Downloads** folder.

### Step 4. Extract the new ZIP

1. Open your **Downloads** folder in File Explorer.
2. Find the new ZIP file → right-click → **Extract All...**
3. Click **Extract**. A new folder appears next to the ZIP, called `Eric-yt-channel-ai-main`.
4. **Move this new folder to the same safe location as the `-old` one.** (Drag-and-drop is fine.) You should now have both folders side by side:
   - `Eric-yt-channel-ai-main` (the new one — fresh code)
   - `Eric-yt-channel-ai-main-old` (the old one — still has your data)

### Step 5. Bring your saved data across (CRITICAL — don't skip)

This is the most important step. Without it, the new version starts blank — no API keys, no channels, no transcripts.

1. Open the **OLD** folder (`Eric-yt-channel-ai-main-old`).
2. Inside it, look for a folder called exactly **`data`** (four lowercase letters). This is where everything you've set up is stored.
3. Right-click on the `data` folder → **Copy** (or just press **Ctrl+C**).
4. Now navigate to the **NEW** folder (`Eric-yt-channel-ai-main`).
5. Paste it in: right-click in an empty area inside the new folder → **Paste** (or **Ctrl+V**).
6. If Windows asks: **"The destination already has a folder named 'data'. Do you want to merge?"** or **"Replace the files in the destination?"** → click **Replace the files in the destination** (or **Yes**). The fresh ZIP comes with an empty `data` folder; we're overwriting it with your real one.

### Step 6. Re-install dependencies (just in case)

The developer sometimes adds new code libraries that the app needs. Running the installer again is a no-op if nothing changed, and quick if something did.

1. Inside the new project folder, find **`install.bat`** → double-click it.
2. A black terminal window opens. Lots of text scrolls past — that's normal.
3. **Wait** until it shows `Installation complete!` and `Press any key to continue...`.
4. Press any key to close the window.

Typical time: 30 seconds to 2 minutes.

### Step 7. Start the new version

1. Inside the new project folder, double-click **`start.bat`**.
2. A new black terminal window opens. After 5-10 seconds you'll see lines like:
   ```
   ▲ Next.js 16.2.4
   - Local:        http://localhost:3000
   ✓ Ready in 283ms
   ```
3. Your browser should automatically open to `http://localhost:3000`. If it doesn't, open your browser yourself and go to that address.

### Step 8. Hard-refresh your browser (CRITICAL)

Your browser caches the app's code to make it load faster — but right after an update, the cached version is outdated and might still show the bugs we just fixed. We need to force a fresh load.

1. Click anywhere on the app's webpage so the browser tab is focused.
2. Press **Ctrl + Shift + R** (hold all three at once). On Mac: **Cmd + Shift + R**.
3. The page reloads. You're now on the new version.

> **If you skip this step**, you might still see the old version and think the update didn't work. Don't skip it.

### Step 9. Verify your data is intact

1. Click **Integrations** in the left sidebar → confirm your API keys are still there (the green "Connected" chips).
2. Click **Dashboard** → confirm your channel(s) are still listed.
3. Pick a video → confirm the transcript (if you had one) is still there.

If all three look right, **delete the `-old` folder** to free up disk space. You're done!

If something is missing, **stop and don't delete the `-old` folder yet**. Screenshot what you see and ask the developer — your data is still safe inside the `-old` folder; we just need to figure out where it went on the way over.

---

## Path B — Update via GitHub Desktop

If you installed GitHub Desktop to clone the project initially, updates are dramatically simpler.

### Step 1. Stop the app

Close the **black terminal window** that's running the app's server. The app is now off.

### Step 2. Open GitHub Desktop

Find GitHub Desktop in your Start menu and open it.

### Step 3. Fetch and pull

1. At the top of GitHub Desktop, make sure the **"Current repository"** dropdown (top-left) shows `Eric-yt-channel-ai`. If it doesn't, click the dropdown and pick it.
2. Look for the **Fetch origin** button near the top (or sometimes labeled "Fetch"). Click it.
3. GitHub Desktop checks the project on GitHub for any new changes. After a second or two, the button changes:
   - If it says **"Pull origin"** with a downward arrow and a number (e.g. "Pull origin · 3 commits behind") → there are new changes. Click it.
   - If it says **"Fetch origin"** unchanged with no number → you're already up to date. Nothing else to do, skip to Step 5.

GitHub Desktop downloads the new files into your existing project folder. Your `data` folder is automatically left alone — no manual copying needed (GitHub Desktop knows not to touch it).

### Step 4. Re-install dependencies (just in case)

Same as Path A Step 6 — open the project folder, double-click `install.bat`, wait for it to finish.

### Step 5. Start the new version

Double-click `start.bat`. The app launches like before.

### Step 6. Hard-refresh your browser

**Ctrl + Shift + R** (or **Cmd + Shift + R** on Mac) on the app's tab. Don't skip this.

### Step 7. Verify your data

Same as Path A Step 9. Check Integrations, Dashboard, a video. Everything should be intact because we never touched the `data` folder.

You're done!

---

## Recommended: switch from ZIP to GitHub Desktop

If you've been using Path A (ZIP downloads), please consider switching to Path B (GitHub Desktop) for future updates. The setup takes about 10 minutes once, and after that every update is **3 clicks** instead of the 9 steps above. You also won't have to remember to copy the `data` folder — GitHub Desktop handles that automatically.

### Why switch?

- **One-click updates.** Open GitHub Desktop → click Fetch → click Pull. That's it.
- **No risk of losing your data.** With ZIP updates, if you forget Step 5 (copy `data` across) you lose everything. GitHub Desktop never touches that folder.
- **No re-download needed.** It only fetches what changed, not the whole project. Usually a few KB instead of 50+ MB.
- **You get to keep your current data, settings, everything.** The switch doesn't reset anything.

### How to switch

#### Step 1. Install GitHub Desktop

1. Open this link in your browser: **[https://desktop.github.com/](https://desktop.github.com/)**
2. Click the big purple **Download for Windows** button (it auto-detects your OS).
3. The installer downloads — once it finishes, double-click it. It installs and opens automatically.

You can sign in with a GitHub account or skip the sign-in step — both work for our public repo. If you don't have an account and don't want to make one, just skip.

#### Step 2. Clone the repository

1. In GitHub Desktop, click **File → Clone repository...** (or press **Ctrl + Shift + O**).
2. A window opens with three tabs at the top. Click the **URL** tab.
3. In the box labeled "Repository URL", paste:
   ```
   https://github.com/Bander4ik/Eric-yt-channel-ai
   ```
4. **Local path**: this is where the project will live on your computer. The default (something like `C:\Users\<your-name>\Documents\GitHub\Eric-yt-channel-ai`) is fine **as long as Documents is not OneDrive-synced**. If it is, click **Choose...** and pick a non-synced location instead (e.g. `C:\Eric-yt-channel-ai-git`).
5. Click **Clone**. GitHub Desktop downloads the project. Takes 10-30 seconds.

#### Step 3. Bring your data into the new clone

You currently have your data inside your old ZIP-installed project folder. We need to move it to the new GitHub Desktop folder so the new version sees it.

1. Open **File Explorer**.
2. Open your **old** project folder (the one you've been using). Find the **`data`** folder inside it. Copy it (right-click → **Copy**, or **Ctrl + C**).
3. Open your **new** project folder (the one GitHub Desktop just cloned). Paste the `data` folder in (right-click → **Paste**, or **Ctrl + V**).
4. If Windows asks to merge or replace → click **Replace the files in the destination**.

#### Step 4. Install + start in the new folder

1. Inside the new folder, double-click **`install.bat`**. Wait for "Installation complete!".
2. Double-click **`start.bat`**.
3. Browser opens. **Ctrl + Shift + R** to hard-refresh.

#### Step 5. Verify and clean up

Check that Integrations, Dashboard, and a video all show your data. If everything is intact, you can delete your old ZIP-installed project folder (the one you copied `data` FROM in step 3).

From now on, every update is just:
1. Close the terminal window (stop the app)
2. Open GitHub Desktop → **Fetch origin** → **Pull origin**
3. Double-click `start.bat`
4. **Ctrl + Shift + R** in the browser

---

## Troubleshooting

### "I don't see a green `<> Code` button on GitHub"

You might be looking at a specific file inside the repository instead of the main page. Make sure the URL bar just shows `https://github.com/Bander4ik/Eric-yt-channel-ai` (with no extra path after it). If it has `/blob/`, `/tree/`, or anything else after `Eric-yt-channel-ai`, click the repository name at the very top to go back to the main view.

### "install.bat failed with an error"

Check the last few lines of the black terminal window before it closed:

- **"Node.js is not installed"** — install Node.js 20+ from [nodejs.org](https://nodejs.org/) (the green "LTS" button), then re-run `install.bat`.
- **"python not found"** or **"youtube-dl-exec needs Python"** — install Python from the Microsoft Store (search for `Python 3.12`, click Get / Install), then re-run `install.bat`.
- **Any other red text** — screenshot it and ask the developer.

### "The black terminal window flashed and closed too fast for me to read it"

This means there was an error and the script gave up. To see the error message:

1. Open File Explorer, navigate to your project folder.
2. Hold the **Shift** key on your keyboard, **right-click in an empty area** of the folder (not on a file).
3. From the menu, pick **Open in Terminal** (or **Open PowerShell window here**).
4. Type `.\install.bat` and press Enter (or `.\start.bat` if you were running that one).
5. The window stays open this time — you can read the error.

### "The app shows the old version even after I updated"

You probably skipped the hard-refresh. Click the app's browser tab, then press **Ctrl + Shift + R** (or **Cmd + Shift + R** on Mac). If that doesn't work, close the entire browser and reopen it.

### "My API keys / channels are missing after the update"

Two possibilities:

1. **You forgot to copy the `data` folder across.** Don't panic — your data is still in the `-old` folder (Path A). Stop the app, copy the `data` folder from `-old` into the new folder (overwrite/replace when asked), restart `start.bat`, hard-refresh the browser.
2. **OneDrive corrupted the database.** If your project is inside `OneDrive\...`, this is the cause. See the "Before you start" section at the top of this guide — move the project to a non-synced location.

### "Port 3000 is already in use" (or "EADDRINUSE")

You have another `start.bat` running somewhere, or another app is using that port. Look for any extra black terminal windows on your taskbar and close them. If that doesn't help, restart your computer — that always frees the port.

---

## Summary card (keep this handy)

**Update via ZIP (Path A):**
1. Stop the app (close terminal)
2. Rename current folder to add `-old`
3. Download fresh ZIP from [github.com/Bander4ik/Eric-yt-channel-ai](https://github.com/Bander4ik/Eric-yt-channel-ai) (green Code button → Download ZIP)
4. Extract to the same safe location as `-old`
5. Copy `data` folder from `-old` into the new folder
6. Run `install.bat` → wait for "Installation complete!"
7. Run `start.bat`
8. **Ctrl + Shift + R** in the browser
9. Verify data is intact, delete `-old`

**Update via GitHub Desktop (Path B):**
1. Stop the app
2. GitHub Desktop → Fetch origin → Pull origin
3. Run `install.bat`
4. Run `start.bat`
5. **Ctrl + Shift + R** in the browser

**Never:**
- Update without closing the running app first
- Skip copying the `data` folder (Path A)
- Skip the hard-refresh (`Ctrl + Shift + R`)
- Keep the project inside OneDrive / iCloud / Dropbox
