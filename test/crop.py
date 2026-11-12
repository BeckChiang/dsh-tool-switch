import sys
from PIL import Image

src = sys.argv[1]
out = sys.argv[2]
x1, y1, x2, y2 = (int(v) for v in sys.argv[3:7])
scale = float(sys.argv[7]) if len(sys.argv) > 7 else 3.0

image = Image.open(src)
crop = image.crop((x1, y1, x2, y2))
crop = crop.resize((int(crop.width * scale), int(crop.height * scale)), Image.LANCZOS)
crop.save(out)
print(out, crop.size)
