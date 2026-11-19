"""Build flashcards and a magazine from the AR Classroom's original dark markers.
Requires Python with Pillow and ReportLab. Run from any working directory.
"""
from pathlib import Path
from collections import OrderedDict
from hashlib import sha256
from io import BytesIO
import json
import subprocess
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.colors import HexColor, white
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets/guides"
TMP = ROOT / "tmp/ar-printables"
OUT.mkdir(parents=True, exist_ok=True)
TMP.mkdir(parents=True, exist_ok=True)
data = json.loads(subprocess.check_output(["node", "--input-type=module", "-e",
    "import {teacherARCatalog} from './js/teacher-ar-catalog.js'; console.log(JSON.stringify({items:teacherARCatalog}))"], cwd=ROOT, text=True, encoding="utf8"))
catalog = data["items"]
unique = OrderedDict()

def register(raw, model, source):
    image = Image.open(BytesIO(raw)).convert("RGBA")
    digest = sha256(str(image.size).encode() + image.tobytes()).hexdigest()
    if digest in unique:
        unique[digest]["sources"].append(source)
        return
    path = TMP / f"marker-{len(unique)+1:02d}.png"
    path.write_bytes(raw)  # Preserve the original, uncropped target bytes.
    unique[digest] = {"number": len(unique)+1, "modelId": model["id"], "title": model["title"],
        "topic": model["topic"], "path": str(path), "sources": [source], "pixelHash": digest,
        "marker": model["marker"], "sourceSha256": sha256(raw).hexdigest()}

for model in catalog:
    register((ROOT / model["marker"].lstrip("/")).read_bytes(), model, "AR Classroom")
cards = list(unique.values())
assert len(cards) == len(catalog), "Use exactly one original AR Classroom marker per model."
assert {card["modelId"] for card in cards} == {model["id"] for model in catalog}
(TMP / "manifest.json").write_text(json.dumps(cards, indent=2), encoding="utf8")
for name in ["Regular", "Bold"]:
    pdfmetrics.registerFont(TTFont(name, str(ROOT / f"assets/fonts/NotoSans-{name}.ttf")))
W, H = landscape(A4)
INK, MUTED, BLUE = "#263c59", "#496583", "#4c6898"
print_images = {}

def print_image(path):
    if path not in print_images:
        source = Image.open(path).convert("RGBA")
        source.thumbnail((1200, 1200), Image.Resampling.LANCZOS)
        image = Image.new("RGB", source.size, "white")
        image.paste(source, mask=source.getchannel("A"))
        encoded = BytesIO()
        image.save(encoded, format="JPEG", quality=95, optimize=True, subsampling=0)
        encoded.seek(0)
        print_images[path] = ImageReader(encoded)
    return print_images[path]

def text(c, value, x, y, size=12, color=INK, font="Regular"):
    c.setFillColor(HexColor(color)); c.setFont(font, size); c.drawString(x, y, value)

def lines(value, width, size=12, font="Regular"):
    result, line = [], ""
    for word in value.split():
        candidate = f"{line} {word}".strip()
        if line and pdfmetrics.stringWidth(candidate, font, size) > width:
            result.append(line); line = word
        else:
            line = candidate
    if line:
        result.append(line)
    return result

def paragraph(c, value, x, y, width, size=12, color=MUTED, leading=None, font="Regular"):
    for line in lines(value, width, size, font):
        text(c, line, x, y, size, color, font); y -= leading or size*1.5
    return y

def foot(c, number, total, label="ImARs / PRINT + SCAN"):
    text(c, label, 40, 24, 8, MUTED)
    c.setFont("Regular", 8); c.drawRightString(W-40, 24, f"{number:02d} / {total:02d}")

def title(c, kicker, heading, subtitle=""):
    text(c, kicker, 50, H-52, 10, BLUE, "Bold")
    text(c, heading, 50, H-94, 30, INK, "Bold")
    if subtitle: paragraph(c, subtitle, 50, H-123, W-100, 12)

def card(c, item, x, y, width=329.6, height=476.2):
    c.setFillColor(HexColor("#fafafa")); c.setStrokeColor(HexColor(BLUE)); c.setLineWidth(4)
    c.roundRect(x, y, width, height, 15, stroke=1, fill=1)
    c.setFillColor(HexColor(BLUE)); c.setFont("Bold", 9)
    c.drawCentredString(x+width/2, y+height-32, f"IMARS / CARD {item['number']:02d}")
    img = print_image(item["path"])
    image_w, image_h = img.getSize()
    scale = min(266/image_w, 266/image_h)
    dw, dh = image_w*scale, image_h*scale
    c.setFillColor(white); c.rect(x+29, y+142, width-58, 276, stroke=0, fill=1)
    c.drawImage(img, x+(width-dw)/2, y+147+(266-dh)/2, dw, dh, mask="auto")
    size = 27
    label = lines(item["title"], width-44, size, "Bold")
    while len(label) > 2:
        size -= 1; label = lines(item["title"], width-44, size, "Bold")
    c.setFillColor(HexColor("#3a3a5a")); c.setFont("Bold", size)
    start = y+105 + (len(label)-1)*size*.5
    for index, value in enumerate(label): c.drawCentredString(x+width/2, start-index*size*1.15, value)
    c.setFont("Regular", 8); c.setFillColor(HexColor(MUTED))
    c.drawCentredString(x+width/2, y+45, " / ".join(item["sources"]))
    c.drawCentredString(x+width/2, y+29, "Keep the full image visible to the webcam.")

def sheet(c, pair, number, total):
    for position, item in enumerate(pair): card(c, item, 59.5 + position*395.0, 59.5)
    foot(c, number, total, "ImARs / " + " + ".join(f"CARD {item['number']:02d}" for item in pair))
    c.showPage()

pairs = [cards[i:i+2] for i in range(0, len(cards), 2)]
deck = canvas.Canvas(str(OUT / "ImARs-AR-Flashcards.pdf"), pagesize=(W,H), pageCompression=1)
deck.setTitle(f"ImARs - {len(cards)} Original AR Classroom Marker Flashcards")
deck.setAuthor("ImARs")
for index, pair in enumerate(pairs): sheet(deck, pair, index+1, len(pairs))
deck.save()

total = ((len(pairs)+7+3)//4)*4
mag = canvas.Canvas(str(OUT / "ImARs-AR-Magazine.pdf"), pagesize=(W,H), pageCompression=1)
mag.setTitle("ImARs - Print, Scan, Discover: AR Magazine")
mag.setAuthor("ImARs")
mag.setFillColor(HexColor("#102e54")); mag.rect(0,0,W,H,stroke=0,fill=1)
text(mag, "IMARS / THE PRINT + SCAN COLLECTION", 52, H-65, 12, "#a6d4ff", "Bold")
text(mag, "SCIENCE,", 50, H-145, 55, "#ffffff", "Bold")
text(mag, "OFF THE PAGE.", 50, H-208, 49, "#ffffff", "Bold")
paragraph(mag, "Your printable AR magazine and classroom flashcard collection.", 54, H-252, 410, 18, "#c6e1f6")
text(mag, f"{len(cards)} image targets  /  {len(catalog)} teaching models", 54, 108, 16, "#ffda85", "Bold")
text(mag, "Print a page. Show a marker. Explore in AR.", 54, 77, 13, "#ffffff")
mag.drawImage(print_image(cards[0]["path"]), W-290, 145, 235,235,mask="auto")
mag.showPage()
title(mag, "QUICK START", "From flashcard to classroom.", "Use these cards with the ImARs teacher website on a laptop with a webcam.")
guide = [("1. Print or display", "Print a flashcard at actual size, or show its marker on a separate screen. Keep the complete target image intact."),
 ("2. Open AR Classroom", "Sign in as a teacher, open AR Classroom, choose Scan markers, and allow camera access when your browser asks."),
 ("3. Face the webcam", "Hold one flashcard upright in front of the laptop camera. Keep your fingers outside the printed image and all edges visible."),
 ("4. Hold and explore", "Hold still until Marker found appears. The matching model loads automatically. Select a pulsing spot for a description and narration.")]
y=H-170
for heading, body in guide:
    text(mag, heading, 54,y,17,INK,"Bold"); paragraph(mag,body,245,y,W-300,12); y-=82
foot(mag,2,total); mag.showPage()
title(mag,"INSIDE THE COLLECTION","One original marker for every model.","This set uses the original dark-background AR Classroom images. Each flashcard opens its matching teaching model.")
y=H-175
topics = list(dict.fromkeys(item["topic"] for item in cards))
for topic in topics:
    numbers=[item["number"] for item in cards if item["topic"]==topic]
    text(mag,topic,54,y,12,INK,"Bold")
    text(mag,"Cards " + ", ".join(f"{n:02d}" for n in numbers),440,y,10,MUTED)
    y-=28
foot(mag,3,total); mag.showPage()
for index,pair in enumerate(pairs): sheet(mag,pair,index+4,total)
page=len(pairs)+4
title(mag,"TEACHER NOTES","A quick classroom routine.")
for n,(heading,body) in enumerate([
 ("Predict","Before scanning, ask learners what they expect the marker to show."),
 ("Observe","Show one flashcard at a time. Let learners identify shapes, parts, motion, or changes."),
 ("Explain","Use the model labels and narration, then ask learners to explain the idea in their own words."),
 ("Connect","Ask for one example from home, school, or the environment.")]):
    y=H-165-n*85; text(mag,heading,54,y,20,INK,"Bold"); paragraph(mag,body,250,y,W-305,13)
foot(mag,page,total); mag.showPage(); page+=1
title(mag,"SCAN SMARTER","If the marker is not recognized.")
tips=[("Too dark or shiny?","Use even lighting. Avoid glare from lamps, sunlight, glossy covers, or plastic sleeves."),
 ("Only part of the image is visible?","Move the flashcard back until the whole target fits in the camera view. Keep the printed image flat."),
 ("Camera unavailable?","Allow camera permission for ImARs and close other apps that are using the webcam."),
 ("Model still loading?","Check your connection, hold the card steady, or use Try again if the website offers it.")]
for n,(heading,body) in enumerate(tips):
    y=H-160-n*85; text(mag,heading,54,y,15,INK,"Bold"); paragraph(mag,body,350,y,W-405,12)
foot(mag,page,total); mag.showPage(); page+=1
title(mag,"MY DISCOVERY PAGE","Scan. Notice. Explain.","Name: ________________________    Section: ________________________    Date: _______________")
for n,prompt in enumerate(["The flashcard or model I explored:","Before scanning, I thought:","After exploring the model, I noticed:","One question I still have:"]):
    y=H-175-n*88; text(mag,prompt,54,y,13,INK,"Bold")
    mag.setStrokeColor(HexColor("#b4c9dc")); mag.line(54,y-25,W-54,y-25); mag.line(54,y-49,W-54,y-49)
foot(mag,page,total); mag.showPage(); page+=1
while page < total:
    title(mag,"MY CLASSROOM NOTES","Make the learning your own.","Flashcard or topic: _____________________________________________________________")
    for n,prompt in enumerate(["What did I observe?", "How would I explain it to a classmate?", "Where can I see this idea in real life?"]):
        y=H-180-n*110; text(mag,prompt,54,y,13,INK,"Bold")
        mag.setStrokeColor(HexColor("#b4c9dc"))
        for offset in [25,49,73]: mag.line(54,y-offset,W-54,y-offset)
    foot(mag,page,total); mag.showPage(); page+=1
mag.setFillColor(HexColor("#102e54")); mag.rect(0,0,W,H,stroke=0,fill=1)
text(mag,"KEEP EXPLORING.",54,H-150,42,"#ffffff","Bold")
paragraph(mag,"The same printed picture can open a whole new way to learn.",58,H-200,570,20,"#c6e1f6")
text(mag,"Print notes",58,220,18,"#ffda85","Bold")
paragraph(mag,"Print in A4 landscape at actual size. For separate flashcards, print the flashcard-only PDF single-sided and cut around the rounded card frames. Do not crop, stretch, recolor, or cover the target images.",58,188,W-116,13,"#ffffff")
text(mag,"Open your ImARs teacher website > AR Classroom > Scan markers",58,90,12,"#c6e1f6")
mag.showPage(); mag.save()
assert page==total
(OUT / "ar-printables.json").write_text(json.dumps({"modelCount": len(catalog), "markerCount": len(cards),
    "flashcardPages": len(pairs), "magazinePages": total,
    "markers": [{k: item[k] for k in ["number", "modelId", "title", "topic", "sources", "pixelHash", "marker", "sourceSha256"]} for item in cards]}, indent=2), encoding="utf8")
print(json.dumps({"markers":len(cards),"models":len(catalog),"flashcardPages":len(pairs),"magazinePages":total}))
