#!/usr/bin/env python3
"""Parche: en el menú de categorías solo la primera letra va en mayúscula
("Energía y movilidad" en vez de "Energía Y Movilidad"). Uso: python3 parche-menu.py"""
import os
f = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app.js")
s = open(f, encoding="utf-8").read()
if "function prettyCat" in s:
    raise SystemExit("Ya estaba aplicado.")
a = "shrink-0 capitalize ${isActive"
b = "${escapeHtml(cat)}\n            </a>"
assert s.count(a) == 1 and s.count(b) == 1, "No encontré el bloque esperado en app.js"
s = s.replace(a, "shrink-0 ${isActive").replace(b, "${escapeHtml(prettyCat(cat))}\n            </a>")
s = s.replace("function renderCategoryFilters() {",
"// Solo la primera letra (ignorando emojis) va en mayúscula.\nfunction prettyCat(c) { return String(c).replace(/\\p{L}/u, ch => ch.toUpperCase()); }\n\nfunction renderCategoryFilters() {", 1)
open(f, "w", encoding="utf-8", newline="\n").write(s)
print("Listo: app.js actualizado.")
