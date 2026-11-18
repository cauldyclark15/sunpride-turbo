#!/usr/bin/env python3
"""Build the Sunpride Field 'adding customers' guide (HTML -> PDF via headless Chrome)."""
import os, subprocess, html

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "shots")
OUT_HTML = os.path.join(HERE, "add-customers.html")  # temporary, deleted after printing
# Published at a stable link: never rename it.
OUT_PDF = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", "apps", "web", "public", "docs", "sunpride-add-customers.pdf"))

def img(name):
    p = os.path.join(SHOTS, name)
    assert os.path.exists(p), p
    return f'<img src="file://{p}">'

def section(num, title, body, shot=None, caption=""):
    fig = f'<figure>{img(shot)}<figcaption>{html.escape(caption)}</figcaption></figure>' if shot else ""
    return f'''<section class="step{' noshot' if not shot else ''}">
  <div class="text"><div class="num">{num}</div><h2>{html.escape(title)}</h2>{body}</div>{fig}
</section>'''

def ol(*items):
    return "<ol>" + "".join(f"<li>{i}</li>" for i in items) + "</ol>"

def note(t):
    return f'<p class="note">{t}</p>'

sections = [
    section(1, "Update the app",
        ol("Open the <b>Play Store</b>.",
           "Tap your profile picture (top right).",
           "Tap <b>Manage apps &amp; device</b>, then <b>Update all</b>.",
           "Open <b>Sunpride Field</b> and sign in as usual.")
        + note("Do NOT uninstall the app. Uninstalling deletes customers that are not yet sent.")),
    section(2, "Your Home page",
        "<p>The app now opens on <b>Home</b>. Everything you need for adding customers is here.</p>"
        + "<ul><li>The big <b>Add customer</b> button.</li>"
          "<li><b>Added today</b> and <b>This week</b>: how many customers you added.</li>"
          "<li><b>Last saved</b>: your latest customers.</li>"
          "<li>At the bottom: <b>Home</b>, <b>Customers</b> and <b>More</b>.</li>"
          "<li>Messages is the speech-bubble icon at the top right.</li></ul>",
        "g01-home-empty.png", "Home"),
    section(3, "Start a new customer",
        ol("Stand in front of the store.",
           "Tap <b>Add customer</b>.",
           "Fill in every field with a red star (*).",
           "Take the <b>storefront photo</b>.")
        + note("You can add customers even with no signal. They are kept safely on your phone and sent when you have signal."),
        "g02-add-customer-form.png", "The Add customer form"),
    section(4, "Fill in the details",
        "<ul><li>Type the names, address and mobile number.</li>"
          "<li>Pick the location from the lists: Region, Province, Municipality, Barangay.</li>"
          "<li>Tap <b>Use my location</b> while standing at the store.</li>"
          "<li>If you cannot find a choice in a list, type part of the name in the search box.</li></ul>",
        "g03-add-customer-filled.png", "A filled-in form"),
    section(5, "Save",
        ol("Scroll down and check every field once more.",
           "Tap <b>Save customer</b>.")
        + "<p>You will see <b>Customer saved</b>. Tap <b>OK</b> to go back to Home. The customer is sent to the office for approval.</p>",
        "g10-saved-dialog.png", "Customer saved"),
    section(6, "Check your progress",
        "<p>Back on <b>Home</b> you will see your counts go up and your customers under <b>Last saved</b>.</p>"
        "<ul><li><b>Sent</b>: the office has it.</li>"
          "<li><b>Waiting to send</b>: it will send by itself when you have signal.</li></ul>",
        "g05-home-after-save.png", "Home after adding customers"),
    section(7, "Find a customer",
        "<p>Tap <b>Customers</b> at the bottom to search by name, code or address.</p>"
        "<p>Customers you just added are at the top under <b>Waiting for approval</b> until the office approves them.</p>",
        "g06-customers-tab.png", "Customers"),
    section(8, "Messages",
        "<p>Tap the <b>speech-bubble icon</b> at the top right to read and send messages. A number on the icon means you have new messages.</p>",
        "g07-messages.png", "Messages"),
    section(9, "More and Sync",
        "<p>Tap <b>More</b> for Products, Add customer, Sync and your Account.</p>"
        "<p>Tap <b>Sync</b> to see if everything is sent. <b>All sent</b> means the office has all your customers. "
        "If it says <b>Waiting to send</b>, move to a place with signal and tap <b>Sync now</b>.</p>",
        "g09-sync.png", "Sync: All sent"),
]

CSS = """
@page{size:A4;margin:14mm 14mm}
html{color-scheme:light}
body{font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;color:#151515;background:#fff;margin:0;font-size:11.5pt;line-height:1.45}
.cover{border-bottom:3px solid #c8102e;padding-bottom:10px;margin-bottom:14px}
.kicker{font-size:9pt;letter-spacing:.14em;text-transform:uppercase;color:#c8102e;font-weight:600}
h1{font-size:24pt;font-weight:600;margin:4px 0 4px}
.sub{color:#5f5d58;margin:0}
.step{display:grid;grid-template-columns:1fr 48mm;gap:8mm;align-items:start;padding:8px 0 12px;border-top:1px solid #e6e3dc;break-inside:avoid}
.step.noshot{grid-template-columns:1fr}
.num{display:inline-block;background:#c8102e;color:#fff;border-radius:50%;width:24px;height:24px;line-height:24px;text-align:center;font-weight:700;font-size:11pt;margin-right:8px;vertical-align:middle}
h2{display:inline;font-size:15pt;vertical-align:middle;margin:0}
.text p,.text ol,.text ul{margin:8px 0 0}
li{margin:3px 0}
figure{margin:0;text-align:center}
figure img{width:48mm;border:1px solid #d9d6cf;border-radius:10px}
figcaption{font-size:9pt;color:#7a7873;margin-top:3px}
.note{background:#fff4e5;border-left:4px solid #f0a020;padding:6px 10px;border-radius:4px}
.foot{margin-top:12px;border-top:1px solid #e6e3dc;padding-top:8px;color:#5f5d58;font-size:10pt}
"""

doc = f"""<!doctype html><html><head><meta charset="utf-8"><title>Sunpride Field App - How to add customers</title><style>{CSS}</style></head><body>
<div class="cover"><div class="kicker">Sunpride Field app</div><h1>How to add customers</h1>
<p class="sub">A short guide to the updated app. The screenshots use sample stores.</p></div>
{''.join(sections)}
<div class="foot">Questions or problems? Tap the speech-bubble icon at the top right and message a Developer, or ask your office admin.</div>
</body></html>"""

open(OUT_HTML, "w").write(doc)
chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--allow-file-access-from-files",
                f"--print-to-pdf={OUT_PDF}", "file://" + OUT_HTML], check=True, capture_output=True)
os.remove(OUT_HTML)
print(OUT_PDF)
