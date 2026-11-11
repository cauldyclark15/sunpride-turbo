#!/usr/bin/env python3
"""SP-0170: build packages/db/reference/ph-geography-psgc-2026q3.json.

Inputs (never committed; record their sha256 in the output's `source` block):
  1. PSA PSGC Publication Datafile (.xlsx). psa.gov.ph blocks scripted downloads
     (Cloudflare challenge), so the exact same file was taken from an open mirror:
     https://raw.githubusercontent.com/rbillyjames0221/psgc-api/main/seed/PSGC-3Q-2026-Publication-Datafile.xlsx
     (official URL https://psa.gov.ph/system/files/scd/PSGC-3Q-2026-Publication-Datafile.xlsx).
  2. PHLPost ZIP code locator table (https://phlpost.gov.ph/zip-code-locator/), committed as
     packages/db/reference/phlpost-zip-locator-raw.json. It only covers part of the country.
  3. Community ZIP list for the rest (simonpangan/Philippines-Zip-Codes version-1.sql,
     extracted from grit.ph, 2024-01-04). Rows from it are marked source='community'.

Run:  uv run --with openpyxl python3 packages/db/scripts/build-ph-geography.py \
        <PSGC.xlsx> <phlpost-raw.json> <zip-version-1.sql> <out.json>

Hierarchy rules (PSGC 10-digit code RR PPP MM BBB):
  - Province  = PSGC 'Prov' rows. Cities PSA places under no province (HUC/ICC, NCR) get their
    geographic province from the 9-digit correspondence code's first four digits; NCR cities and
    Pateros get the four traditional NCR district pseudo-provinces (kind 'district').
  - Municipality = PSGC 'City', 'Mun' and Manila 'SubMun' rows that own barangays.
  - Barangay parent = first 7 digits + '000' (its city/municipality/sub-municipality).
"""
import hashlib, json, re, sys, unicodedata
import openpyxl

psgc_path, phl_path, zip_sql_path, out_path = sys.argv[1:5]

def sha(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()

wb = openpyxl.load_workbook(psgc_path, read_only=True)
meta = {r[0]: r[1] for r in wb['Metadata'].iter_rows(values_only=True) if r and r[0]}
rows = []
for r in wb['PSGC'].iter_rows(min_row=2, values_only=True):
    if not r[1] or not r[4]:
        continue
    code = str(r[1]).strip()
    corr = r[3]
    corr = str(corr).strip().zfill(9) if corr is not None else ''
    rows.append({'code': code, 'name': ' '.join(str(r[2]).split()), 'corr': corr,
                 'level': r[4], 'cityClass': r[6] or None})

regions = [r for r in rows if r['level'] == 'Reg']
provs = [r for r in rows if r['level'] == 'Prov']
cities = [r for r in rows if r['level'] in ('City', 'Mun', 'SubMun')]
bgys = [r for r in rows if r['level'] == 'Bgy']

prov_by_code = {p['code']: p for p in provs}
prov_by_corr4 = {p['corr'][:4]: p for p in provs}
NCR_DISTRICTS = {
    '1339': ('1339000000', 'NCR, City of Manila, First District'),
    '1374': ('1374000000', 'NCR, Second District'),
    '1375': ('1375000000', 'NCR, Third District'),
    '1376': ('1376000000', 'NCR, Fourth District'),
}
province_rows = [{'code': p['code'], 'regionCode': p['code'][:2] + '00000000', 'name': p['name'], 'kind': 'province'} for p in provs]
pseudo = {}

def province_of(c):
    p = c['code'][:5] + '00000'
    if p in prov_by_code:
        return p
    key = c['corr'][:4]
    if key in prov_by_corr4 and prov_by_corr4[key]['code'][:2] == c['code'][:2]:
        return prov_by_corr4[key]['code']
    if key in NCR_DISTRICTS:
        code, name = NCR_DISTRICTS[key]
        pseudo.setdefault(code, {'code': code, 'regionCode': '1300000000', 'name': name, 'kind': 'district'})
        return code
    # Last resort: the city stands as its own province-level entry.
    pseudo.setdefault(c['code'], {'code': c['code'], 'regionCode': c['code'][:2] + '00000000', 'name': c['name'], 'kind': 'city'})
    return c['code']

bgy_parents = {b['code'][:7] + '000' for b in bgys}
munis = []
for c in cities:
    if c['code'] not in bgy_parents:
        continue  # e.g. City of Manila itself: its barangays sit under the sub-municipalities
    name = c['name']
    if c['level'] == 'SubMun':
        name = f"{name}, City of Manila"
    munis.append({'code': c['code'], 'provinceCode': province_of(c), 'regionCode': c['code'][:2] + '00000000',
                  'name': name, 'kind': {'City': 'city', 'Mun': 'municipality', 'SubMun': 'sub_municipality'}[c['level']],
                  'cityClass': c['cityClass']})
province_rows += sorted(pseudo.values(), key=lambda p: p['code'])
muni_codes = {m['code'] for m in munis}
barangays = [{'code': b['code'], 'municipalityCode': b['code'][:7] + '000', 'name': b['name']} for b in bgys]
orphans = [b for b in barangays if b['municipalityCode'] not in muni_codes]
assert not orphans, orphans[:5]

# ---------- postal codes ----------
def norm(s):
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()
    s = re.sub(r'\(.*?\)', ' ', s)
    s = s.replace('sto.', 'santo').replace('sta.', 'santa').replace('gen.', 'general')
    s = re.sub(r'\bcity of\b|\bcity\b|\bmunicipality of\b|\bpoblacion\b', ' ', s)
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()

prov_name = {p['code']: p['name'] for p in province_rows}
by_prov = {}
for m in munis:
    by_prov.setdefault(norm(prov_name[m['provinceCode']]), []).append(m)
by_name = {}
for m in munis:
    by_name.setdefault(norm(m['name']), []).append(m)

def match(province, city):
    cn = norm(city)
    cands = [m for m in by_prov.get(norm(province), []) if norm(m['name']) == cn]
    if len(cands) == 1:
        return cands[0]
    cands = by_name.get(cn, [])
    if len(cands) == 1:
        return cands[0]
    return None

postal = {}
unmatched = []
def add(m, z, area, source):
    key = (m['code'], z)
    if key not in postal:
        postal[key] = {'municipalityCode': m['code'], 'postalCode': z, 'area': area, 'source': source}

phl = json.load(open(phl_path))
for r in phl:
    z = str(r['zip_code']).strip()
    if not re.fullmatch(r'\d{4}', z):
        continue
    m = match(r['province'], r['city_municipality'])
    if m:
        add(m, z, None, 'phlpost')
    else:
        unmatched.append(('phlpost', r['province'], r['city_municipality'], z))

sql = open(zip_sql_path, encoding='utf-8').read()
tuple_re = re.compile(r"^\((\d+), '([^']*)', (NULL|'(?:[^'\\]|\\.)*'), (NULL|'(?:[^'\\]|\\.)*'), '((?:[^'\\]|\\.)*)', '(\d{4})', '[^']*'\)", re.M)
def unq(v):
    return None if v == 'NULL' else v[1:-1].replace("\\'", "'")
manila_subs = {norm(m['name'].replace(', City of Manila', '')): m for m in munis if m['kind'] == 'sub_municipality'}
for t in tuple_re.finditer(sql):
    div, prov, city, loc, z = t.group(2), unq(t.group(3)), unq(t.group(4)), t.group(5).replace("\\'", "'"), t.group(6)
    if div == 'NCR':
        cn = norm(city)
        if cn == 'manila':
            m = manila_subs.get(norm(loc))
            if m:
                add(m, z, loc, 'community'); continue
            unmatched.append(('community', 'NCR', f'{city}/{loc}', z)); continue
        cands = [m for m in munis if m['regionCode'] == '1300000000' and norm(m['name']) == cn]
        if len(cands) == 1:
            add(cands[0], z, loc, 'community')
        else:
            unmatched.append(('community', 'NCR', f'{city}/{loc}', z))
        continue
    m = match(prov or '', loc)
    if m:
        add(m, z, None, 'community')
    else:
        unmatched.append(('community', prov, loc, z))

postal_rows = sorted(postal.values(), key=lambda p: (p['municipalityCode'], p['postalCode']))
with_postal = {p['municipalityCode'] for p in postal_rows}
out = {
    'source': {
        'psgc': {
            'title': meta.get('Title:'), 'originator': meta.get('Originator:'),
            'publicationDate': meta.get('Publication date:'),
            'release': 'Third Quarter 2026 PSGC Updates (PSA ref. 2026-331, released 2026-10-12)',
            'officialUrl': 'https://psa.gov.ph/system/files/scd/PSGC-3Q-2026-Publication-Datafile.xlsx',
            'mirrorUrl': 'https://raw.githubusercontent.com/rbillyjames0221/psgc-api/main/seed/PSGC-3Q-2026-Publication-Datafile.xlsx',
            'sha256': sha(psgc_path),
        },
        'postal': [
            {'name': 'PHLPost ZIP code locator', 'url': 'https://phlpost.gov.ph/zip-code-locator/',
             'file': 'packages/db/reference/phlpost-zip-locator-raw.json', 'sha256': sha(phl_path), 'rows': len(phl)},
            {'name': 'Community ZIP list (grit.ph extract, 2024-01-04)',
             'url': 'https://raw.githubusercontent.com/simonpangan/Philippines-Zip-Codes/main/version-1.sql',
             'sha256': sha(zip_sql_path)},
        ],
    },
    'counts': {
        'regions': len(regions), 'provinces': len(province_rows), 'municipalities': len(munis),
        'barangays': len(barangays), 'postalCodes': len(postal_rows),
        'municipalitiesWithPostal': len(with_postal), 'postalUnmatched': len(unmatched),
    },
    'regions': [{'code': r['code'], 'name': r['name']} for r in regions],
    'provinces': province_rows,
    'municipalities': munis,
    # Compact: [code, name] grouped by municipality code.
    'barangays': {},
    'postalCodes': [[p['municipalityCode'], p['postalCode'], p['area'], p['source']] for p in postal_rows],
}
for b in barangays:
    out['barangays'].setdefault(b['municipalityCode'], []).append([b['code'], b['name']])
json.dump(out, open(out_path, 'w'), ensure_ascii=False, separators=(',', ':'))
print(json.dumps(out['counts']))
print('sample unmatched:', unmatched[:15])
