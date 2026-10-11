"""
Generate alumni invite codes
============================
Run from the backend directory:
    python invite.py 5      # generate and print 5 invite codes
    python invite.py        # default: generate 3

Copy the printed codes to alumni (one each). An alumnus chooses the "Invite code"
method on the sign-in page, enters their name + invite code to sign up / sign in,
no cell phone number needed.
"""
import sys
import os
import secrets

from flask import Flask

from models import db, InviteCode


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    basedir = os.path.abspath(os.path.dirname(__file__))
    app = Flask(__name__)
    app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///" + os.path.join(basedir, "pahub.db")
    db.init_app(app)

    with app.app_context():
        db.create_all()
        codes = []
        for _ in range(n):
            c = secrets.token_hex(4).upper()  # 8 uppercase letters/digits
            db.session.add(InviteCode(code=c))
            codes.append(c)
        db.session.commit()

    print("Generated %d invite codes:" % n)
    for c in codes:
        print("  " + c)
    print("Copy them to alumni, one each.")


if __name__ == "__main__":
    main()
