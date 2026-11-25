"""SP-0254: vendor only open low-resolution administrative boundaries.
Run from the repo root. No Arc code or data is used.
"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request

# Published immutable quarter tag; never follow latest at runtime.
BASE = 'https://raw.githubusercontent.com/faeldon/philippines-json-maps/v1.1.1/'
OUT = Path(__file__).resolve().parents[1] / 'apps/web/public/maps/ph'
OUT.mkdir(parents=True, exist_ok=True)

def fetch(source, target):
    raw = urllib.request.urlopen(BASE + source, timeout=60).read()
    data = json.loads(raw)
    # The customer picker stores Manila's fourteen sub-municipalities at its city
    # level. Use the publisher's actual SubMun shapes, never fabricated splits.
    if target == 'p-1303900000.json':
        source = 'latest/topojson/municities/lowres/bgysubmuns-municity-1380600000.topo.0.001.json'
        data = json.loads(urllib.request.urlopen(BASE + source, timeout=60).read())
        obj = next(iter(data['objects'].values()))
        obj['geometries'] = [g for g in obj['geometries'] if g['properties']['geo_level'] == 'SubMun']
        assert len(obj['geometries']) == 14
    # Strip unused attributes, retain canonical IDs and names; preserve topology.
    obj = next(iter(data['objects'].values()))
    for g in obj['geometries']:
        p = g['properties']
        level = 4 if p.get('geo_level') == 'SubMun' else 3 if 'adm3_psgc' in p else 2 if 'adm2_psgc' in p else 1
        g['id'] = str(p[f'adm{level}_psgc']).zfill(10)
        g['properties'] = {'name': p[f'adm{level}_en']}
    data['objects'] = {'areas': obj}
    text = json.dumps(data, separators=(',', ':'))
    (OUT / target).write_text(text)
    return {'file': target, 'source': source, 'bytes': len(text.encode()),
            'sha256': hashlib.sha256(text.encode()).hexdigest(),
            'count': len(obj['geometries'])}, [g['id'] for g in obj['geometries']]

def main():
    national, regions = fetch('latest/topojson/country/lowres/country.topo.0.001.json','regions.json')
    records = [national]
    provinces=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for rec, ids in pool.map(lambda c: fetch(f'latest/topojson/regions/lowres/provdists-region-{int(c)}.topo.0.001.json',f'r-{c}.json'), regions):
            records.append(rec);provinces.extend(ids)
        for rec, _ in pool.map(lambda c: fetch(f'latest/topojson/provdists/lowres/municities-provdist-{int(c)}.topo.0.001.json',f'p-{c}.json'), provinces):
            records.append(rec)
    # Keep a server-side, geometry-derived parent index in the API image. City
    # PSGC is the join; a source parent can differ from the picker's pseudo-
    # province (NCR districts, Isabela and the Special Geographic Area).
    hierarchy = {'regions': regions, 'provinces': {}, 'cities': {},
                 'provinceAliases': {'1339000000':'1303900000','1374000000':'1307400000',
                    '1375000000':'1307500000','1376000000':'1307600000','0990101000':'0990100000'}}
    for region in regions:
        shapes = json.loads((OUT / f'r-{region}.json').read_text())['objects']['areas']['geometries']
        for shape in shapes:
            province = shape['id']
            hierarchy['provinces'][province] = region
            children = json.loads((OUT / f'p-{province}.json').read_text())['objects']['areas']['geometries']
            for city in children:
                assert city['id'] not in hierarchy['cities']
                hierarchy['cities'][city['id']] = [province, region]
    official = json.loads((Path(__file__).resolve().parents[1] / 'packages/db/reference/ph-geography-psgc-2026q3.json').read_text())
    assert set(hierarchy['cities']) == {c['code'] for c in official['municipalities']}
    api_index = Path(__file__).resolve().parents[1] / 'apps/api/src/domains/fieldsync/areas-geography.json'
    api_index.write_text(json.dumps(hierarchy, indent=2) + '\n')
    manifest={'source':BASE,'quarter':'2026-3q','attribution':'NAMRIA / PSA through OCHA COD-AB, CC BY-IGO 3.0; faeldon/philippines-json-maps, MIT','files':sorted(records,key=lambda r:r['file'])}
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    license_text=urllib.request.urlopen(BASE+'LICENSE',timeout=30).read().decode()
    (OUT/'LICENSE.txt').write_text(manifest['attribution']+'\nhttps://data.humdata.org/dataset/cod-ab-phl\nhttps://creativecommons.org/licenses/by/3.0/igo/\n\n'+license_text.rstrip()+'\n')
    print(json.dumps({'files':len(records),'bytes':sum(r['bytes'] for r in records),'regions':len(regions),'provinces':len(provinces)}))

if __name__=='__main__':main()
