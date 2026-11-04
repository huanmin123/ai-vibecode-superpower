import os

from flask import Flask

from views import views

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("APP_SECRET_KEY", "change-me-in-production")
app.config["DEBUG"] = os.environ.get("FLASK_DEBUG", "1") == "1"
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024
app.register_blueprint(views)


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "5000")),
        debug=app.config["DEBUG"],
    )
