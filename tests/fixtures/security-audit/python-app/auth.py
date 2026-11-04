from functools import wraps

from flask import abort, g, session

import storage


def current_user():
    cached = getattr(g, "current_user", None)
    if cached is not None:
        return cached

    user_id = session.get("user_id")
    if not user_id:
        return None

    user = storage.get_user(user_id)
    g.current_user = user
    return user


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if current_user() is None:
            abort(401, description="login required")
        return view(*args, **kwargs)

    return wrapped
