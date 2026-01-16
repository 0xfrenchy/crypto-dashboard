# 📊 Crypto Derivatives Dashboard

A real-time dashboard showing **Open Interest**, **Funding Rates**, and **Long/Short Ratios** for BTC and ETH perpetual futures across multiple exchanges.

![Dashboard Preview](https://via.placeholder.com/800x400?text=Dashboard+Preview)

## Features

- **Multi-exchange data**: Aggregates data from Binance, Bybit, OKX, and Bitget
- **Real-time updates**: Auto-refreshes every 60 seconds
- **24-hour charts**: Mini sparkline charts showing trends
- **Info tooltips**: Hover over (?) icons to learn what each metric means
- **Clean UI**: Dark trading terminal aesthetic

---

## 🚀 Step-by-Step Setup Guide

### Prerequisites

Before starting, you need:
1. **A computer** (Windows, Mac, or Linux)
2. **An internet connection**
3. **About 30 minutes** of time

---

### Step 1: Install Node.js

Node.js is the platform that runs our server code.

**On Windows:**
1. Go to https://nodejs.org
2. Download the **LTS** version (the big green button on the left)
3. Run the installer
4. Click "Next" through all the steps (keep defaults)
5. Click "Install"

**On Mac:**
1. Go to https://nodejs.org
2. Download the **LTS** version
3. Open the downloaded `.pkg` file
4. Follow the installer steps

**Verify it worked:**
Open a terminal/command prompt and type:
```bash
node --version
```
You should see something like `v20.10.0` (the number doesn't have to match exactly)

---

### Step 2: Install Visual Studio Code (VS Code)

VS Code is a free code editor that makes working with code much easier.

1. Go to https://code.visualstudio.com
2. Download for your operating system
3. Run the installer
4. Launch VS Code when done

---

### Step 3: Install Git

Git lets you upload your code to GitHub.

**On Windows:**
1. Go to https://git-scm.com/download/win
2. Download and run the installer
3. Click "Next" through all steps (keep defaults)

**On Mac:**
1. Open Terminal (search for "Terminal" in Spotlight)
2. Type: `git --version`
3. If not installed, it will prompt you to install - click "Install"

**Verify it worked:**
```bash
git --version
```
You should see something like `git version 2.42.0`

---

### Step 4: Create a GitHub Account

1. Go to https://github.com
2. Click "Sign up"
3. Follow the steps to create your account
4. **Important**: Remember your username and password!

---

### Step 5: Download the Project Files

1. Open VS Code
2. Press `Ctrl+Shift+P` (Windows) or `Cmd+Shift+P` (Mac)
3. Type "Git: Clone" and select it
4. You'll upload your own files instead. Skip this for now.

**Alternative - Create manually:**
1. Create a new folder on your computer called `crypto-dashboard`
2. Open VS Code
3. Go to File → Open Folder → Select your `crypto-dashboard` folder

---

### Step 6: Add the Project Files

Copy these files into your `crypto-dashboard` folder:
- `package.json`
- `server.js`
- `.env`
- `.env.example`
- `.gitignore`
- `public/index.html` (create a folder called `public` first)

---

### Step 7: Install Dependencies

1. In VS Code, open the terminal: View → Terminal (or press `` Ctrl+` ``)
2. Make sure you're in the project folder (it should show `crypto-dashboard` in the terminal)
3. Run this command:

```bash
npm install
```

This downloads all the required packages. Wait for it to finish (might take 1-2 minutes).

---

### Step 8: Test Locally

1. In the terminal, run:

```bash
npm start
```

2. You should see:
```
🚀 Crypto Dashboard server running on port 3000
📊 Open http://localhost:3000 in your browser
```

3. Open your browser and go to: `http://localhost:3000`
4. You should see your dashboard! 🎉

**To stop the server:** Press `Ctrl+C` in the terminal

---

### Step 9: Create a GitHub Repository

1. Go to https://github.com
2. Click the `+` icon in the top right → "New repository"
3. Name it: `crypto-dashboard`
4. Keep it **Public** (required for free Railway deployment)
5. **Don't** check any boxes (no README, no .gitignore)
6. Click "Create repository"

---

### Step 10: Upload to GitHub

In your VS Code terminal, run these commands **one at a time**:

```bash
git init
```
(This sets up Git in your folder)

```bash
git add .
```
(This stages all your files)

```bash
git commit -m "Initial commit"
```
(This creates your first save point)

```bash
git branch -M main
```
(This names your branch)

```bash
git remote add origin https://github.com/YOUR_USERNAME/crypto-dashboard.git
```
⚠️ **Replace `YOUR_USERNAME` with your actual GitHub username!**

```bash
git push -u origin main
```
(This uploads everything to GitHub)

If prompted for credentials, enter your GitHub username and password (or personal access token).

---

### Step 11: Create a Railway Account

Railway is a platform that hosts your app for free.

1. Go to https://railway.app
2. Click "Login" in the top right
3. Click "Login with GitHub"
4. Authorize Railway to access your GitHub

---

### Step 12: Deploy to Railway

1. In Railway, click **"New Project"**
2. Click **"Deploy from GitHub repo"**
3. Find and select your `crypto-dashboard` repository
4. Click **"Deploy Now"**

Railway will start building your app. Wait 2-3 minutes.

---

### Step 13: Add Your API Key to Railway

**Important**: Your `.env` file isn't uploaded to GitHub (for security). You need to add the API key in Railway.

1. In your Railway project, click on your service (the purple box)
2. Click the **"Variables"** tab
3. Click **"+ New Variable"**
4. Add these two variables:

| Variable Name | Value |
|--------------|-------|
| `COINALYZE_API_KEY` | `b5f2b690-ee5a-4c3a-95e1-15ec1d597b3e` |
| `PORT` | `3000` |

5. Railway will automatically redeploy

---

### Step 14: Get Your Live URL

1. In Railway, click on your service
2. Click the **"Settings"** tab
3. Scroll down to **"Domains"**
4. Click **"Generate Domain"**
5. You'll get a URL like: `crypto-dashboard-production-abc123.up.railway.app`

🎉 **Your dashboard is now live!** Share this URL with anyone!

---

## 📖 Understanding the Dashboard

### Open Interest (OI)
**What it is**: The total value of all open futures positions.

| Signal | Meaning |
|--------|---------|
| 📈 Rising OI + Rising Price | Strong uptrend, new money entering |
| 📈 Rising OI + Falling Price | Strong downtrend, shorts piling in |
| 📉 Falling OI + Rising Price | Short squeeze or weak rally |
| 📉 Falling OI + Falling Price | Long squeeze or capitulation |

### Funding Rate
**What it is**: A fee paid every 8 hours between long and short traders.

| Signal | Meaning |
|--------|---------|
| 🟢 Positive (Green) | Longs pay shorts. Market is bullish. |
| 🔴 Negative (Red) | Shorts pay longs. Market is bearish. |
| ⚠️ Very High Positive | Overleveraged longs, potential drop |
| ⚠️ Very Negative | Overleveraged shorts, potential squeeze |

### Long/Short Ratio
**What it is**: The ratio of traders going long vs short.

| Signal | Meaning |
|--------|---------|
| > 1.0 | More longs than shorts (bullish sentiment) |
| < 1.0 | More shorts than longs (bearish sentiment) |
| Extreme readings | Often precede reversals |

---

## 🔧 Troubleshooting

### "npm not found"
→ Node.js wasn't installed correctly. Reinstall from nodejs.org

### "git not found"  
→ Git wasn't installed correctly. Reinstall and restart your terminal

### Dashboard shows "--" for all values
→ Check that your API key is correct in Railway variables

### "429 Too Many Requests" error
→ You're hitting the rate limit (40 requests/minute). Wait a minute and refresh.

### Railway deploy fails
→ Check the deploy logs in Railway for specific errors

---

## 📁 Project Structure

```
crypto-dashboard/
├── public/
│   └── index.html      # Frontend (what you see in browser)
├── server.js           # Backend (handles API calls)
├── package.json        # Project configuration
├── .env                # Your API key (not uploaded to GitHub)
├── .env.example        # Template for .env
├── .gitignore          # Files to ignore in Git
└── README.md           # This file
```

---

## 🆘 Need Help?

1. **Re-read the step** you're stuck on
2. **Google the error message** - someone else has probably had the same issue
3. **Check Railway logs** - they often tell you exactly what's wrong

---

## 📜 License

Free to use. Data provided by [Coinalyze](https://coinalyze.net).
