"""
PaHub Backend - Main Program
============================
Flask + SQLAlchemy + SQLite

Run (from the backend directory):
    python app.py       # start the server, open http://127.0.0.1:5000 in a browser

All endpoints return JSON.
"""
import os
import random
import re
from datetime import timedelta
from functools import wraps
from uuid import uuid4

from flask import Flask, jsonify, request, session, send_from_directory
from flask_cors import CORS

from models import db, User, Item, Comment, Star, Need, NeedReply, Follow, Bookmark, Report, View, NeedSupport, InviteCode, utcnow

# ---------- App initialization ----------
basedir = os.path.abspath(os.path.dirname(__file__))
app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-change-me")
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///" + os.path.join(basedir, "pahub.db")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["JSON_AS_ASCII"] = False  # keep non-ASCII characters readable instead of \uXXXX escapes
db.init_app(app)
CORS(app, supports_credentials=True)

# ---------- Section config (kept in sync with the frontend) ----------
SECTIONS = [
    {"id": "academic", "name": "Academic", "subs": [
        {"id": "gpa", "name": "GPA", "desc": "Grades · Course Selection · GPA Boost"},
        {"id": "research", "name": "Research", "desc": "Projects · Papers · Labs"},
        {"id": "competition", "name": "Competition", "desc": "Math Modeling · Electronics · Award Tips"},
        {"id": "assessment", "name": "Assessment", "desc": "Extra Credits · Activities · Awards"},
    ]},
    {"id": "career", "name": "Career", "subs": [
        {"id": "internship", "name": "Internship", "desc": "Internships · Referrals · Interview Tips"},
        {"id": "study-abroad", "name": "Study Abroad", "desc": "Applications · Languages · School Choice"},
    ]},
]
SEC_NAMES = {}
for big in SECTIONS:
    for s in big["subs"]:
        SEC_NAMES[s["id"]] = {"big": big["name"], "name": s["name"]}


def sec_name(sec_id):
    return SEC_NAMES.get(sec_id, {}).get("name", sec_id)


def sec_path(sec_id):
    info = SEC_NAMES.get(sec_id, {})
    if info:
        return info["big"] + " › " + info["name"]
    return sec_id


def time_ago(dt):
    """Convert a datetime to a relative time string like 'just now / X min ago / X day ago'."""
    if dt is None:
        return ""
    delta = utcnow() - dt
    seconds = delta.total_seconds()
    if seconds < 60:
        return "just now"
    minutes = int(seconds // 60)
    if minutes < 60:
        return str(minutes) + " min ago"
    hours = int(minutes // 60)
    if hours < 24:
        return str(hours) + " hr ago"
    days = int(hours // 24)
    if days < 7:
        return str(days) + " day ago"
    weeks = int(days // 7)
    return str(weeks) + " wk ago"


def save_upload(file):
    """Save an uploaded file to the uploads/ directory; return (stored_name, original_name), or (None, None) if none."""
    if not file or not file.filename:
        return None, None
    ext = os.path.splitext(file.filename)[1]
    stored = uuid4().hex + ext
    upload_dir = os.path.join(basedir, "uploads")
    os.makedirs(upload_dir, exist_ok=True)
    file.save(os.path.join(upload_dir, stored))
    return stored, file.filename


# ---------- Auth helpers ----------
# Temporary verification-code store: {phone_number: {"code": "1234", "expire": time}}
_verification_codes = {}


def current_user():
    """Return the logged-in user from the session, or None if not logged in."""
    uid = session.get("user_id")
    if uid is None:
        return None
    return User.query.get(uid)


def login_required(f):
    """Endpoint decorator: requires a logged-in user."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if current_user() is None:
            return jsonify({"error": "Please sign in first"}), 401
        return f(*args, **kwargs)
    return wrapper


# ---------- Sections ----------
@app.get("/api/sections")
def get_sections():
    return jsonify({"sections": SECTIONS})


# ---------- Auth ----------
@app.post("/api/auth/send-code")
def send_code():
    data = request.get_json(silent=True) or {}
    number = (data.get("number") or "").strip()
    if not number:
        return jsonify({"error": "Please enter your cell phone number first"}), 400
    code = str(random.randint(1000, 9999))
    _verification_codes[number] = {
        "code": code,
        "expire": utcnow() + timedelta(minutes=5),
    }
    # Demo: return the code directly so it can be shown on the page. In production, send an SMS instead.
    return jsonify({"ok": True, "code": code})


@app.post("/api/auth/login")
def login():
    """Sign in: account + name (no verification code needed)."""
    data = request.get_json(silent=True) or {}
    account = (data.get("account") or "").strip().lower()
    name = (data.get("name") or "").strip()

    if not account or not name:
        return jsonify({"error": "Please enter your account and name"}), 400
    user = User.query.filter_by(account=account).first()
    if not user or user.name != name:
        return jsonify({"error": "Incorrect account or name"}), 401
    session["user_id"] = user.id
    return jsonify({"ok": True, "created": False, "user": user.to_brief()})


@app.post("/api/auth/student")
def student_auth():
    """Student sign-up: account + name + SMS verification code."""
    data = request.get_json(silent=True) or {}
    account = (data.get("account") or "").strip().lower()
    name = (data.get("name") or "").strip()
    number = (data.get("number") or "").strip()
    code = (data.get("code") or "").strip()
    college = (data.get("college") or "").strip()

    if not account or not name:
        return jsonify({"error": "Please enter your account and name"}), 400
    if not re.fullmatch(r"[A-Za-z0-9]{3,20}", account):
        return jsonify({"error": "Account must be 3-20 letters or digits"}), 400
    if User.query.filter_by(account=account).first():
        return jsonify({"error": "This account is already registered"}), 400
    if User.query.filter_by(name=name).first():
        return jsonify({"error": "This name is already registered"}), 400
    record = _verification_codes.get(number)
    if not record or record["expire"] < utcnow() or code != record["code"]:
        return jsonify({"error": "Please enter your cell phone number and get a verification code"}), 400

    user = User(account=account, name=name, student_id=account, number=number,
                college=college, bio="")
    db.session.add(user)
    db.session.commit()
    _verification_codes.pop(number, None)
    session["user_id"] = user.id
    return jsonify({"ok": True, "created": True, "user": user.to_brief()})


@app.post("/api/auth/alumnus")
def alumnus_auth():
    """Alumnus sign-up: account + name + invite code."""
    data = request.get_json(silent=True) or {}
    account = (data.get("account") or "").strip().lower()
    name = (data.get("name") or "").strip()
    inv = (data.get("invite") or "").strip().upper()

    if not account or not name:
        return jsonify({"error": "Please enter your account and name"}), 400
    if not re.fullmatch(r"[A-Za-z0-9]{3,20}", account):
        return jsonify({"error": "Account must be 3-20 letters or digits"}), 400
    if User.query.filter_by(account=account).first():
        return jsonify({"error": "This account is already registered"}), 400
    if User.query.filter_by(name=name).first():
        return jsonify({"error": "This name is already registered"}), 400
    if not inv:
        return jsonify({"error": "Please enter the invite code"}), 400
    invite = InviteCode.query.filter_by(code=inv).first()
    if not invite:
        return jsonify({"error": "Invalid invite code"}), 400
    if invite.user_id is not None:
        return jsonify({"error": "Invite code already used"}), 400

    user = User(account=account, name=name, student_id=account, number="",
                college="", bio="")
    db.session.add(user)
    db.session.flush()
    invite.user_id = user.id
    db.session.commit()
    session["user_id"] = user.id
    return jsonify({"ok": True, "created": True, "user": user.to_brief()})


@app.post("/api/auth/logout")
def logout():
    session.pop("user_id", None)
    return jsonify({"ok": True})


@app.get("/api/me")
def me():
    user = current_user()
    if user is None:
        return jsonify({"user": None})
    return jsonify({"user": user.to_brief()})


# ---------- User profile ----------
@app.get("/api/users/<int:uid>")
def get_user(uid):
    user = User.query.get(uid)
    if user is None:
        return jsonify({"error": "User not found"}), 404
    d = user.to_dict()
    cur = current_user()
    d["is_followed"] = (cur is not None and
                        Follow.query.filter_by(follower_id=cur.id, followee_id=uid).first() is not None)
    return jsonify({"user": d})


@app.get("/api/users/<int:uid>/items")
def get_user_items(uid):
    user = User.query.get(uid)
    if user is None:
        return jsonify({"error": "User not found"}), 404
    itype = request.args.get("type")          # 'asset' / 'comment' / None (all)
    q = (request.args.get("q") or "").strip().lower()
    items = user.items
    if itype in ("asset", "comment"):
        items = items.filter(Item.type == itype)
    items = items.order_by(Item.created_at.desc()).all()
    if q:
        items = [it for it in items
                 if q in (it.title + " " + (it.desc or "") + " " + it.type).lower()]
    cur = current_user()
    return jsonify({"items": [it.to_dict(cur.id if cur else None) for it in items]})


@app.put("/api/users/<int:uid>/bio")
@login_required
def update_bio(uid):
    user = User.query.get(uid)
    if user is None:
        return jsonify({"error": "User not found"}), 404
    if current_user().id != uid:
        return jsonify({"error": "You can only edit your own bio"}), 403
    data = request.get_json(silent=True) or {}
    user.bio = (data.get("bio") or "").strip()
    db.session.commit()
    return jsonify({"ok": True, "bio": user.bio})


@app.get("/api/users/<int:uid>/following")
def get_following(uid):
    user = User.query.get(uid)
    if user is None:
        return jsonify({"error": "User not found"}), 404
    rows = Follow.query.filter_by(follower_id=uid).all()
    followed = [User.query.get(r.followee_id) for r in rows]
    return jsonify({"following": [u.to_brief() for u in followed if u]})


@app.post("/api/users/<int:uid>/follow")
@login_required
def toggle_follow(uid):
    target = User.query.get(uid)
    if target is None:
        return jsonify({"error": "User not found"}), 404
    follower_id = current_user().id
    if follower_id == uid:
        return jsonify({"error": "You cannot follow yourself"}), 400
    row = Follow.query.filter_by(follower_id=follower_id, followee_id=uid).first()
    if row:
        db.session.delete(row)
        followed = False
    else:
        db.session.add(Follow(follower_id=follower_id, followee_id=uid))
        followed = True
    db.session.commit()
    return jsonify({"ok": True, "followed": followed})


# ---------- Content ----------
@app.get("/api/items")
def list_items():
    section = request.args.get("section")
    sort = request.args.get("sort", "hot")     # hot = by stars / new = by views
    q = (request.args.get("q") or "").strip().lower()

    query = Item.query
    if section:
        query = query.filter(Item.section == section)
    items = query.all()
    if q:
        items = [it for it in items
                 if q in (it.title + " " + (it.desc or "") + " " + it.type).lower()]
    if sort == "hot":
        items.sort(key=lambda it: it.likes, reverse=True)
    else:
        items.sort(key=lambda it: it.views, reverse=True)
    cur = current_user()
    return jsonify({"items": [it.to_dict(cur.id if cur else None) for it in items]})


@app.get("/api/items/<int:iid>")
def get_item(iid):
    it = Item.query.get(iid)
    if it is None:
        return jsonify({"error": "Content not found"}), 404
    cur = current_user()
    if cur is not None:
        # count one view per user per item
        if View.query.filter_by(user_id=cur.id, item_id=it.id).first() is None:
            db.session.add(View(user_id=cur.id, item_id=it.id))
            it.views += 1
    else:
        it.views += 1
    db.session.commit()
    data = it.to_dict(cur.id if cur else None)
    data["comments"] = [c.to_dict() for c in it.comments.order_by(Comment.created_at.asc())]
    data["sec_path"] = sec_path(it.section)
    return jsonify({"item": data})


@app.post("/api/items")
@login_required
def create_item():
    # supports two submit styles: JSON (no file) and multipart/form-data (with file)
    if request.is_json:
        data = request.get_json(silent=True) or {}
        file = None
    else:
        data = request.form.to_dict()
        file = request.files.get("file")

    itype = data.get("type")
    title = (data.get("title") or "").strip()
    desc = (data.get("desc") or "").strip()
    section = data.get("section") or "gpa"
    need_id = data.get("need_id")            # optional: reply to a need post

    if itype not in ("asset", "comment"):
        return jsonify({"error": "type must be asset or comment"}), 400
    if not title:
        return jsonify({"error": "Please enter a title/content"}), 400

    user = current_user()
    it = Item(user_id=user.id, type=itype, section=section,
              title=title, desc=desc)
    stored, original = save_upload(file)
    if stored:
        it.file_name = original
        it.file_path = stored

    db.session.add(it)
    db.session.flush()   # get it.id first

    if need_id:
        try:
            need_id = int(need_id)
        except (TypeError, ValueError):
            need_id = None
        need = Need.query.get(need_id)
        if need:
            db.session.add(NeedReply(need_id=need.id, item_id=it.id))

    db.session.commit()
    return jsonify({"ok": True, "item": it.to_dict(user.id)})


@app.delete("/api/items/<int:iid>")
@login_required
def delete_item(iid):
    user = current_user()
    it = Item.query.get(iid)
    if it is None:
        return jsonify({"error": "Content not found"}), 404
    if it.user_id != user.id:
        return jsonify({"error": "You can only delete your own content"}), 403
    # clean up related rows to avoid orphan records
    Star.query.filter_by(item_id=it.id).delete()
    Bookmark.query.filter_by(item_id=it.id).delete()
    View.query.filter_by(item_id=it.id).delete()
    NeedReply.query.filter_by(item_id=it.id).delete()
    Comment.query.filter_by(item_id=it.id).delete()
    # delete the attachment file
    if it.file_path:
        try:
            os.remove(os.path.join(basedir, "uploads", it.file_path))
        except OSError:
            pass
    db.session.delete(it)
    db.session.commit()
    return jsonify({"ok": True})


@app.post("/api/items/<int:iid>/star")
@login_required
def toggle_star(iid):
    it = Item.query.get(iid)
    if it is None:
        return jsonify({"error": "Content not found"}), 404
    uid = current_user().id
    star = Star.query.filter_by(user_id=uid, item_id=iid).first()
    if star:
        db.session.delete(star)
        it.likes = max(0, (it.likes or 0) - 1)
        starred = False
    else:
        db.session.add(Star(user_id=uid, item_id=iid))
        it.likes = (it.likes or 0) + 1
        starred = True
    db.session.commit()
    return jsonify({"ok": True, "starred": starred, "star_count": it.likes})


@app.post("/api/items/<int:iid>/comments")
@login_required
def add_comment(iid):
    it = Item.query.get(iid)
    if it is None:
        return jsonify({"error": "Content not found"}), 404
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "Comment cannot be empty"}), 400
    c = Comment(item_id=iid, user_id=current_user().id, text=text)
    db.session.add(c)
    db.session.commit()
    return jsonify({"ok": True, "comment": c.to_dict()})


@app.get("/api/items/<int:iid>/download")
def download_item_file(iid):
    it = Item.query.get(iid)
    if it is None or not it.file_path:
        return jsonify({"error": "No attachment"}), 404
    return send_from_directory(
        os.path.join(basedir, "uploads"), it.file_path,
        as_attachment=True, download_name=it.file_name or it.file_path)


@app.post("/api/items/<int:iid>/bookmark")
@login_required
def toggle_bookmark(iid):
    it = Item.query.get(iid)
    if it is None:
        return jsonify({"error": "Content not found"}), 404
    uid = current_user().id
    bm = Bookmark.query.filter_by(user_id=uid, item_id=iid).first()
    if bm:
        db.session.delete(bm)
        bookmarked = False
    else:
        db.session.add(Bookmark(user_id=uid, item_id=iid))
        bookmarked = True
    db.session.commit()
    return jsonify({"ok": True, "bookmarked": bookmarked})


@app.get("/api/me/bookmarks")
@login_required
def my_bookmarks():
    user = current_user()
    rows = Bookmark.query.filter_by(user_id=user.id).order_by(Bookmark.created_at.desc()).all()
    items = []
    for r in rows:
        it = Item.query.get(r.item_id)
        if it:
            items.append(it.to_dict(user.id))
    return jsonify({"items": items})


@app.post("/api/reports")
@login_required
def create_report():
    text = (request.form.get("text") or "").strip()
    if not text:
        return jsonify({"error": "Please enter your report text"}), 400
    file = request.files.get("file")
    r = Report(user_id=current_user().id, text=text)
    stored, original = save_upload(file)
    if stored:
        r.file_name = original
        r.file_path = stored
    db.session.add(r)
    db.session.commit()
    return jsonify({"ok": True})


# ---------- Needs ----------
@app.get("/api/needs")
def list_needs():
    needs = Need.query.order_by(Need.created_at.desc()).all()
    cur = current_user()
    return jsonify({"needs": [need_to_dict(n, cur.id if cur else None) for n in needs]})


@app.get("/api/needs/<int:nid>")
def get_need(nid):
    n = Need.query.get(nid)
    if n is None:
        return jsonify({"error": "Need not found"}), 404
    cur = current_user()
    return jsonify({"need": need_to_dict(n, cur.id if cur else None)})


def need_to_dict(n, current_user_id=None):
    replies = []
    for r in n.replies.order_by(NeedReply.created_at.asc()):
        it = Item.query.get(r.item_id)
        if it:
            replies.append(it.to_dict(current_user_id))
    return {
        "id": n.id,
        "user_id": n.user_id,
        "section": n.section,
        "sec_name": sec_name(n.section),
        "title": n.title,
        "needs": n.needs,
        "time_ago": time_ago(n.created_at),
        "created_at": n.created_at.isoformat(),
        "author": n.author.to_brief(),
        "replies": replies,
    }


@app.post("/api/needs")
@login_required
def create_need():
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    section = data.get("section") or "gpa"
    if not title:
        return jsonify({"error": "Please enter the resource you need"}), 400

    # at most 2 per day
    user = current_user()
    today_start = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    count = Need.query.filter(Need.user_id == user.id,
                              Need.created_at >= today_start).count()
    if count >= 2:
        return jsonify({"error": "You've already posted 2 needs today, come back tomorrow"}), 400

    n = Need(user_id=user.id, section=section, title=title, needs=1)
    db.session.add(n)
    db.session.commit()
    return jsonify({"ok": True, "need": need_to_dict(n, user.id)})


@app.post("/api/needs/<int:nid>/need-also")
@login_required
def need_also(nid):
    n = Need.query.get(nid)
    if n is None:
        return jsonify({"error": "Need not found"}), 404
    user = current_user()
    if n.user_id == user.id:
        return jsonify({"ok": True, "needs": n.needs, "message": "You already counted once when you posted"})
    if NeedSupport.query.filter_by(user_id=user.id, need_id=n.id).first() is not None:
        return jsonify({"ok": True, "needs": n.needs, "message": "You've already contributed, can't add more"})
    db.session.add(NeedSupport(user_id=user.id, need_id=n.id))
    n.needs += 1
    db.session.commit()
    return jsonify({"ok": True, "needs": n.needs})


# ---------- Search ----------
@app.get("/api/search")
def search():
    q = (request.args.get("q") or "").strip().lower()
    if not q:
        return jsonify({"users": [], "items": []})

    users = User.query.filter(
        db.or_(User.name.contains(q), User.bio.contains(q))
    ).all()

    items = Item.query.all()
    items = [it for it in items
             if q in (it.title + " " + (it.desc or "")).lower()]

    cur = current_user()
    return jsonify({
        "users": [u.to_brief() for u in users],
        "items": [it.to_dict(cur.id if cur else None) for it in items],
    })


# ---------- Frontend page ----------
@app.get("/")
def index():
    return send_from_directory("static", "index.html")


@app.get("/api/health")
def health():
    return jsonify({"app": "PaHub", "status": "running"})


if __name__ == "__main__":
    # create tables automatically on first run (empty database)
    with app.app_context():
        db.create_all()
    app.run(host="0.0.0.0", port=5000, debug=True)
