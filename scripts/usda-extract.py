#!/usr/bin/env python3
"""Extract, for the app's foods only, the official USDA values from files the reviewer downloaded:
  - FNDDS 2021-2023 "At A Glance - Ingredient Nutrient Values" (.xlsx; ingredient code = SR Legacy NDB number)
  - FoodData Central Foundation Foods CSV folder (optional; matched by NDB_number)
Usage: python3 -I scripts/usda-extract.py <ingredient_nutrient_values.xlsx> [<foundation_csv_dir>]
Writes data/review/usda-fndds-subset.csv and data/review/usda-foundation-subset.csv. Never edits src/data/foods.json.
Requires openpyxl (pip install openpyxl) — a reviewer tool, not a runtime dependency of the app.
"""
import csv, json, os, re, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
NUTRIENTS = {208: 'kcal', 203: 'protein', 204: 'fat', 205: 'carb', 291: 'fiber', 303: 'iron_mg', 301: 'calcium_mg', 328: 'vitd_ug'}
FDC_NUTRIENTS = {'1008': 'kcal', '2047': 'kcal_atwater_general', '1003': 'protein', '1004': 'fat', '1005': 'carb', '1079': 'fiber', '1089': 'iron_mg', '1087': 'calcium_mg', '1114': 'vitd_ug'}

def app_ndbs():
    foods = json.load(open(os.path.join(ROOT, 'src', 'data', 'foods.json'), encoding='utf-8'))
    foods = foods if isinstance(foods, list) else foods['foods']
    out = {}
    for f in foods:
        src = str(f.get('source') or '')
        m = re.search(r'\bNDB (\d{4,6})\b', src) or re.search(r'USDA SR Legacy (\d{4,6})\b', src)
        if m: out.setdefault(int(m.group(1)), []).append(f['id'])
    corr = os.path.join(ROOT, 'data', 'review', 'ndb-corrections.json')
    if os.path.exists(corr):
        for fid, c in json.load(open(corr, encoding='utf-8'))['corrections'].items(): out.setdefault(int(c['to']), []).append(fid)
    return out

def fndds(path, wanted):
    import openpyxl
    ws = openpyxl.load_workbook(path, read_only=True)['Ingredient Nutrient Values']
    rows = ws.iter_rows(values_only=True)
    header = None
    for r in rows:
        if r and r[0] == 'Ingredient code': header = r; break
    if not header or list(header[:6]) != ['Ingredient code', 'Ingredient description', 'Nutrient code', 'Nutrient description', 'Nutrient value', 'Nutrient value source']:
        sys.exit('unexpected FNDDS sheet layout')
    out = []
    for r in rows:
        if not r or r[0] is None: continue
        code, desc, ncode, _nd, val, src, fdc = r[0], r[1], r[2], r[3], r[4], r[5], r[6]
        if int(code) in wanted and int(ncode) in NUTRIENTS:
            out.append({'ndb': int(code), 'description': desc, 'nutrient': NUTRIENTS[int(ncode)], 'value': val, 'value_source': src, 'fdc_id': fdc or ''})
    return out

def foundation(folder, wanted):
    ndb = {}
    with open(os.path.join(folder, 'foundation_food.csv'), encoding='utf-8') as fh:
        for r in csv.DictReader(fh):
            if r['NDB_number'].isdigit() and int(r['NDB_number']) in wanted: ndb[r['fdc_id']] = int(r['NDB_number'])
    desc = {}
    with open(os.path.join(folder, 'food.csv'), encoding='utf-8') as fh:
        for r in csv.DictReader(fh):
            if r['fdc_id'] in ndb: desc[r['fdc_id']] = r['description']
    out = []
    with open(os.path.join(folder, 'food_nutrient.csv'), encoding='utf-8') as fh:
        for r in csv.DictReader(fh):
            if r['fdc_id'] in ndb and r['nutrient_id'] in FDC_NUTRIENTS:
                out.append({'ndb': ndb[r['fdc_id']], 'fdc_id': r['fdc_id'], 'description': desc.get(r['fdc_id'], ''), 'nutrient': FDC_NUTRIENTS[r['nutrient_id']], 'value': r['amount']})
    return out

def write(name, rows, cols):
    p = os.path.join(ROOT, 'data', 'review', name)
    with open(p, 'w', newline='', encoding='utf-8') as fh:
        w = csv.DictWriter(fh, fieldnames=cols); w.writeheader(); w.writerows(sorted(rows, key=lambda x: (x['ndb'], x['nutrient'])))
    print(f'{name}: {len(rows)} rows')

if __name__ == '__main__':
    if len(sys.argv) < 2: sys.exit(__doc__)
    wanted = app_ndbs()
    write('usda-fndds-subset.csv', fndds(sys.argv[1], wanted), ['ndb', 'description', 'nutrient', 'value', 'value_source', 'fdc_id'])
    if len(sys.argv) > 2: write('usda-foundation-subset.csv', foundation(sys.argv[2], wanted), ['ndb', 'fdc_id', 'description', 'nutrient', 'value'])
