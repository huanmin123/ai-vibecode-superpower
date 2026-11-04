import base64
import os
import pickle
import subprocess
import zipfile

import yaml
from flask import (
    Blueprint,
    abort,
    jsonify,
    render_template,
    render_template_string,
    request,
    send_file,
)
from werkzeug.utils import secure_filename

import storage
from auth import login_required

views = Blueprint("views", __name__)

SAFE_COMMANDS = {
    "uptime": ["/usr/bin/uptime"],
    "disk": ["/usr/bin/df", "-h"],
}


@views.route("/")
def index():
    return jsonify({"service": "workspace-api", "status": "ok"})


@views.route("/hello")
def hello():
    name = request.args.get("name", "guest")
    template = "<h1>Hello " + name + "!</h1>"
    return render_template_string(template)


@views.route("/profile")
def profile():
    raw = request.cookies.get("profile")
    if not raw:
        abort(401, description="profile cookie is required")

    try:
        data = pickle.loads(base64.b64decode(raw))
    except Exception:
        abort(400, description="invalid profile cookie")

    return jsonify({"profile": data})


@views.route("/download")
def download():
    filename = request.args.get("file", "")
    if not filename:
        abort(400, description="file is required")

    path = os.path.join(storage.BASE_DIR, filename)
    if not os.path.isfile(path):
        abort(404, description="file not found")

    return send_file(path, as_attachment=True)


@views.route("/orders/<int:order_id>")
@login_required
def order_detail(order_id):
    order = storage.get_order(order_id)
    if order is None:
        abort(404, description="order not found")

    return jsonify(order)


@views.route("/search")
def search():
    query = request.args.get("q", "")
    sql = f"SELECT id, title, body FROM notes WHERE title LIKE '%{query}%'"
    rows = storage.fetch_all(sql)
    return jsonify({"results": rows})


@views.route("/restore", methods=["POST"])
@login_required
def restore():
    upload = request.files.get("archive")
    if upload is None or upload.filename == "":
        abort(400, description="archive is required")
    if not upload.filename.lower().endswith(".zip"):
        abort(415, description="only zip archives are supported")

    os.makedirs(storage.RESTORE_DIR, exist_ok=True)
    archive_path = os.path.join(storage.RESTORE_DIR, secure_filename(upload.filename))
    upload.save(archive_path)

    with zipfile.ZipFile(archive_path) as archive:
        archive.extractall(storage.RESTORE_DIR)

    return jsonify({"restored": upload.filename})


@views.route("/safe-search")
def safe_search():
    query = request.args.get("q", "")
    rows = storage.fetch_all(
        "SELECT id, title, body FROM notes WHERE title LIKE ?",
        (f"%{query}%",),
    )
    return jsonify({"results": rows})


@views.route("/safe-run")
@login_required
def safe_run():
    command = request.args.get("command", "uptime")
    argv = SAFE_COMMANDS.get(command)
    if argv is None:
        abort(400, description="unknown command")

    result = subprocess.run(argv, shell=False, capture_output=True, text=True, timeout=10)
    return jsonify({"exitCode": result.returncode, "output": result.stdout})


@views.route("/safe-render")
def safe_render():
    name = request.args.get("name", "guest")
    return render_template("hello.html", name=name)


@views.route("/safe-config")
def safe_config():
    raw = request.get_data(as_text=True)
    if not raw:
        abort(400, description="yaml body is required")

    try:
        values = yaml.safe_load(raw) or {}
    except yaml.YAMLError:
        abort(400, description="invalid yaml")

    if not isinstance(values, dict):
        abort(400, description="yaml object is required")

    return jsonify({"keys": sorted(values.keys())})
