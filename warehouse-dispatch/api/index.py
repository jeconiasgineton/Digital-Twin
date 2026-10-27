import sys
from pathlib import Path

# A função da Vercel roda a partir desta pasta; o pacote `app` fica um nível acima.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.demo_api import app  # noqa: E402
