# PaHub

A nonprofit learning-resource-sharing platform: vanilla HTML/CSS/JS on the frontend, Python + Flask + SQLAlchemy + SQLite on the backend.

## Quick Start

Requires Python 3.10 or newer.

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Start the server
python app.py
```

Then open <http://127.0.0.1:5000> in a browser.

The database (`pahub.db`, empty) is created automatically on first start — no extra setup needed.

## Configuration

- **SECRET_KEY**: optional. Set it via an environment variable in production (a dev-only default is used when unset):

  - Windows: `set SECRET_KEY=your-secret`
  - Linux / Mac: `export SECRET_KEY=your-secret`

## Directory Structure

```
backend/
├── app.py            # main program (all endpoints)
├── models.py         # data models (table schemas)
├── invite.py         # generate alumni invite codes
├── requirements.txt  # dependencies
└── static/           # frontend (index.html + app.js)
```

## Main Endpoints

- `GET  /api/sections` — section list
- `POST /api/auth/login` — sign in (account + name)
- `POST /api/auth/student` — student sign-up (account + name + SMS code + college)
- `POST /api/auth/alumnus` — alumnus sign-up (account + name + invite code)
- `GET  /api/items` — content list
- `POST /api/items` — publish content
- `POST /api/items/<id>/star` — star / unstar
- `POST /api/items/<id>/comments` — comment
- `GET  /api/users/<id>` — user profile
- `GET  /api/search?q=` — search
- See `app.py` for the remaining endpoints

## Notes

- The database is SQLite (a single file), zero configuration.
- The sign-up verification code is currently a demo implementation (returned directly, no SMS service). Wire up an SMS provider for production.
- Sign-in has no password (account + name). Add a password for production.
- For production, use gunicorn / uwsgi instead of Flask's built-in dev server.
