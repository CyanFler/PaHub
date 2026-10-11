"""
PaHub Backend - Data Models
===========================
Define the database table structures with SQLAlchemy.

Tables (each maps to the frontend):
- users        users (name, student_id, college, bio, level)
- items        content (asset resources / comment posts)
- comments     comments on an item
- stars        stars (each user can star each item once)
- needs        resource-request posts
- need_replies replies to a need (point to an item, enabling "cross-linking")
- follows      follow relationships (who follows whom)
"""
from datetime import datetime, timezone

from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


def utcnow():
    """Return naive UTC time (SQLite stores timezone-less time; use this for consistency)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def star_total(user_id):
    """Total stars a user received (sum of likes across their items)."""
    return db.session.query(db.func.coalesce(db.func.sum(Item.likes), 0)) \
        .filter(Item.user_id == user_id).scalar()


def level_name(total):
    """Return the level name based on total stars received."""
    if total >= 100:
        return "Gold"
    if total >= 30:
        return "Advanced"
    if total >= 10:
        return "Intermediate"
    return "Primary"


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(20), unique=True, nullable=False)   # name (Chinese)
    student_id = db.Column(db.String(40), unique=True, nullable=False)  # student ID / authorized ID
    number = db.Column(db.String(20), default="")                  # cell phone number
    account = db.Column(db.String(40), default="", unique=True)    # login account (letters + digits)
    college = db.Column(db.String(60), default="")                   # college (free text)
    bio = db.Column(db.Text, default="")                           # self-intro
    level = db.Column(db.String(30), default="New Student Lv.0")   # level
    created_at = db.Column(db.DateTime, default=utcnow)

    items = db.relationship("Item", backref="author", lazy="dynamic",
                            cascade="all, delete-orphan")
    comments = db.relationship("Comment", backref="author", lazy="dynamic")
    needs = db.relationship("Need", backref="author", lazy="dynamic")

    def to_brief(self):
        """Brief user info (for lists / author display)."""
        return {
            "id": self.id,
            "name": self.name,
            "college": self.college or "",
            "letter": self.name[0] if self.name else "",
            "level": level_name(star_total(self.id)),
            "bio": self.bio or "",
        }

    def to_dict(self):
        """Full user info (for the profile page)."""
        uploads = self.items.count()
        likes = db.session.query(db.func.coalesce(db.func.sum(Item.likes), 0)) \
            .filter(Item.user_id == self.id).scalar()
        followers = Follow.query.filter_by(followee_id=self.id).count()
        return {
            "id": self.id,
            "name": self.name,
            "college": self.college or "",
            "letter": self.name[0] if self.name else "",
            "level": level_name(int(likes)),
            "bio": self.bio or "",
            "stats": {"uploads": uploads, "likes": int(likes), "followers": followers},
        }


class Item(db.Model):
    __tablename__ = "items"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    type = db.Column(db.String(10), nullable=False)      # 'asset' | 'comment'
    section = db.Column(db.String(20), nullable=False)   # gpa / research / ...
    title = db.Column(db.String(200), nullable=False)
    desc = db.Column(db.Text, default="")                # description for assets
    file_name = db.Column(db.String(200), default="")    # original attachment file name
    file_path = db.Column(db.String(200), default="")    # stored attachment name
    likes = db.Column(db.Integer, default=0)             # base star count
    views = db.Column(db.Integer, default=0)             # view count
    created_at = db.Column(db.DateTime, default=utcnow)

    comments = db.relationship("Comment", backref="item", lazy="dynamic",
                               cascade="all, delete-orphan")

    def to_dict(self, current_user_id=None):
        starred = False
        bookmarked = False
        if current_user_id is not None:
            starred = Star.query.filter_by(
                user_id=current_user_id, item_id=self.id).first() is not None
            bookmarked = Bookmark.query.filter_by(
                user_id=current_user_id, item_id=self.id).first() is not None
        return {
            "id": self.id,
            "user_id": self.user_id,
            "type": self.type,
            "section": self.section,
            "title": self.title,
            "desc": self.desc or "",
            "file_name": self.file_name or "",
            "likes": self.likes,
            "views": self.views,
            "comment_count": self.comments.count(),
            "starred": starred,
            "bookmarked": bookmarked,
            "author": self.author.to_brief(),
        }


class Comment(db.Model):
    __tablename__ = "comments"

    id = db.Column(db.Integer, primary_key=True)
    item_id = db.Column(db.Integer, db.ForeignKey("items.id"), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    text = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "author_id": self.user_id,
            "author": self.author.name,
            "author_level": level_name(star_total(self.user_id)),
            "text": self.text,
            "time": self.created_at.isoformat(),
        }


class Star(db.Model):
    __tablename__ = "stars"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    item_id = db.Column(db.Integer, db.ForeignKey("items.id"), nullable=False)

    __table_args__ = (
        db.UniqueConstraint("user_id", "item_id", name="uq_star_user_item"),
    )


class Need(db.Model):
    __tablename__ = "needs"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    section = db.Column(db.String(20), nullable=False)
    title = db.Column(db.String(200), nullable=False)
    needs = db.Column(db.Integer, default=1)             # needs count
    created_at = db.Column(db.DateTime, default=utcnow)

    replies = db.relationship("NeedReply", backref="need", lazy="dynamic",
                              cascade="all, delete-orphan")


class NeedReply(db.Model):
    """A reply to a need: points to an item (asset/comment cross-link)."""

    __tablename__ = "need_replies"

    id = db.Column(db.Integer, primary_key=True)
    need_id = db.Column(db.Integer, db.ForeignKey("needs.id"), nullable=False)
    item_id = db.Column(db.Integer, db.ForeignKey("items.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow)


class Follow(db.Model):
    __tablename__ = "follows"

    id = db.Column(db.Integer, primary_key=True)
    follower_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    followee_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)

    __table_args__ = (
        db.UniqueConstraint("follower_id", "followee_id", name="uq_follow_pair"),
    )


class Bookmark(db.Model):
    """Bookmark: a user bookmarks an item (private, different from starring)."""

    __tablename__ = "bookmarks"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    item_id = db.Column(db.Integer, db.ForeignKey("items.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow)

    __table_args__ = (
        db.UniqueConstraint("user_id", "item_id", name="uq_bookmark_user_item"),
    )


class Report(db.Model):
    """Report: visible to admins only, not public."""

    __tablename__ = "reports"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    text = db.Column(db.Text, nullable=False)             # report text
    file_name = db.Column(db.String(200), default="")     # original attachment file name
    file_path = db.Column(db.String(200), default="")     # stored attachment name
    created_at = db.Column(db.DateTime, default=utcnow)


class View(db.Model):
    """View: each user counts once per item."""

    __tablename__ = "views"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    item_id = db.Column(db.Integer, db.ForeignKey("items.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow)

    __table_args__ = (
        db.UniqueConstraint("user_id", "item_id", name="uq_view_user_item"),
    )


class NeedSupport(db.Model):
    """Need support: each user counts once per need."""

    __tablename__ = "need_supports"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    need_id = db.Column(db.Integer, db.ForeignKey("needs.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow)

    __table_args__ = (
        db.UniqueConstraint("user_id", "need_id", name="uq_need_support_user_need"),
    )


class InviteCode(db.Model):
    """Invite code: a one-time code for alumni; once bound it becomes the alumnus's login credential."""

    __tablename__ = "invite_codes"

    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(40), unique=True, nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    created_at = db.Column(db.DateTime, default=utcnow)
