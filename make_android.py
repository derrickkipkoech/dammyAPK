"""Builds www/ (what goes inside the app) from android-app/src: the panel, the bridge and the engine.
Run:  python android-app/make_android.py      (the GitHub workflow runs it before every build)"""
import os, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
WWW = os.path.join(HERE, "www")
HEAD = ('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">'
        '<meta name="mobile-web-app-capable" content="yes"><meta name="theme-color" content="#000000">'
        '<style>*{touch-action:manipulation;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none}'
        'html,body{overscroll-behavior:none}</style>')


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def main():
    for name in ("dxarrangernew1.html", "bridge.js", "engine.js"):
        if not os.path.isfile(os.path.join(SRC, name)):
            sys.exit(f"missing android-app/src/{name}")
    html = read(os.path.join(SRC, "dxarrangernew1.html"))
    j = html.find("</head>")
    html = html[:j] + HEAD + html[j:] if j >= 0 else HEAD + html
    tags = '<script src="engine.js"></script><script src="bridge.js"></script>'   # engine first: it answers the panel's /api calls
    i = html.rfind("</body>")
    html = html[:i] + tags + html[i:] if i >= 0 else html + tags
    shutil.rmtree(WWW, ignore_errors=True)
    os.makedirs(WWW)
    with open(os.path.join(WWW, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    for name in ("bridge.js", "engine.js"):
        shutil.copyfile(os.path.join(SRC, name), os.path.join(WWW, name))
    print("www/ ready:", sorted(os.listdir(WWW)))


if __name__ == "__main__":
    main()
