/*
 * Parcel data sources.
 *
 * Every source here is a free, public, no-key web service published by a state, county or city
 * government. Each was checked to answer browser requests (CORS) when this file was written.
 *
 * To add a county or state, copy an entry with the same `type`, change the URL and write a
 * `normalize()` that maps the service's field names onto the common record shape:
 *
 *   {
 *     owners:      ['NAME', ...]        current owner name(s); [] if not published
 *     ownerNote:   'why no owner'       optional explanation when owners is empty
 *     parcelId, address, place
 *     acres, acresLabel                 recorded size (falls back to mapped size)
 *     sales:       [{ date, price, buyers?, sellers?, book?, note? }]   any sales the parcel record carries
 *     acquired:    Date                 date the current owner acquired it, if that's all we know
 *     keys:        {...}                identifiers a history provider needs
 *     link:        { url, label }       official record page for this parcel
 *     details:     [[label, value], ...]
 *   }
 *
 * `level` drives the coverage colours: 'history' | 'sales' | 'owner' | 'lines'
 */
'use strict';

const S = {}; // small helpers for normalizers

S.pick = (a, keys) => {
  for (const k of keys) {
    const v = U.clean(a[k]);
    if (v !== null) return a[k];
  }
  return null;
};
S.num = (v) => {
  const n = U.parseMoney(v);
  return n === null || n <= 0 ? null : n;
};
S.money = (v) => U.fmtMoney(S.num(v));
S.owners = (...vals) => {
  const out = [];
  for (const v of vals) {
    const n = U.name(v);
    if (n && !out.some((o) => o.toUpperCase() === n.toUpperCase())) out.push(n);
  }
  return out;
};
S.join = (...parts) => parts.map(U.clean).filter(Boolean).join(', ') || null;
S.sale = (date, price, extra = {}) => {
  const d = date instanceof Date ? date : U.parseDate(date, extra.hint);
  const p = U.parseMoney(price);
  if (!d && !(p > 0)) return null;
  const { hint, ...rest } = extra;
  return { date: d, price: p, ...rest };
};
S.sales = (...list) => list.filter(Boolean);

const ESRI = (url) => url; // marker for readability

const SOURCES = [
  /* ---------------- City & county sources (checked first) ---------------- */
  {
    id: 'nyc',
    name: 'New York City MapPLUTO + ACRIS',
    publisher: 'NYC Dept. of City Planning; NYC Dept. of Finance (ACRIS)',
    homepage: 'https://www.nyc.gov/site/planning/data-maps/open-data/dwn-pluto-mappluto.page',
    region: 'New York City',
    bbox: [-74.26, 40.49, -73.69, 40.92],
    counties: ['36005', '36047', '36061', '36081', '36085'],
    level: 'history',
    type: 'arcgis',
    url: ESRI('https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/ArcGIS/rest/services/MAPPLUTO/FeatureServer/0'),
    history: 'acris',
    note: 'Recorded deeds (buyers, sellers, dates and prices) come from ACRIS, the city register, whose digital records reach back to the 1960s in most boroughs. Condo units are recorded on their own unit lots, so a condo building may show little history.',
    normalize(a) {
      return {
        owners: S.owners(a.OwnerName),
        parcelId: a.BBL ? `BBL ${a.BBL}` : null,
        address: U.clean(a.Address),
        place: { MN: 'Manhattan', BX: 'Bronx', BK: 'Brooklyn', QN: 'Queens', SI: 'Staten Island' }[a.Borough] || null,
        acres: S.num(a.LotArea) ? a.LotArea / 43560 : null,
        acresLabel: 'lot area',
        keys: { boro: a.BoroCode, block: a.Block, lot: a.Lot },
        link: { url: `https://zola.planning.nyc.gov/l/lot/${a.BoroCode}/${a.Block}/${a.Lot}`, label: 'NYC ZoLa lot page' },
        details: [
          ['Year built', U.clean(a.YearBuilt)],
          ['Building class', U.clean(a.BldgClass)],
          ['Zoning', U.clean(a.ZoneDist1)],
          ['Total units', U.clean(a.UnitsTotal)],
          ['Assessed value', S.money(a.AssessTot)],
          ['Owner type', { C: 'City', M: 'Mixed city/private', O: 'Other public', P: 'Private', X: 'Tax-exempt' }[a.OwnerType] || null],
        ],
      };
    },
  },
  {
    id: 'phl',
    name: 'Philadelphia parcels + Realty Transfer Tax records',
    publisher: 'City of Philadelphia (Water Dept., Office of Property Assessment, Dept. of Records)',
    homepage: 'https://opendataphilly.org/datasets/real-estate-transfers/',
    region: 'Philadelphia',
    bbox: [-75.29, 39.86, -74.95, 40.14],
    counties: ['42101'],
    level: 'history',
    type: 'carto',
    table: 'pwd_parcels',
    idField: 'brt_id',
    history: 'phl-rtt',
    note: 'Full deed history (grantors, grantees, dates, consideration) from the city’s realty transfer tax records, mostly 1999 onward.',
    normalize(a) {
      return {
        owners: S.owners(a.owner1, a.owner2),
        parcelId: a.brt_id ? `OPA ${a.brt_id}` : null,
        address: U.clean(a.address),
        place: 'Philadelphia',
        keys: { opa: U.clean(a.brt_id) },
        link: a.brt_id ? { url: `https://property.phila.gov/?p=${a.brt_id}`, label: 'Philadelphia property record' } : null,
        details: [['Building', U.clean(a.bldg_desc)]],
      };
    },
    async enrich(rec, signal) {
      if (!rec.keys.opa) return;
      const sql = `SELECT owner_1, owner_2, sale_date, sale_price, market_value, total_area, year_built, category_code_description, zoning FROM opa_properties_public WHERE parcel_number='${rec.keys.opa.replace(/'/g, '')}' LIMIT 1`;
      const j = await U.fetchJSON(`https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(sql)}`, { signal });
      const r = j.rows && j.rows[0];
      if (!r) return;
      rec.owners = S.owners(r.owner_1, r.owner_2).length ? S.owners(r.owner_1, r.owner_2) : rec.owners;
      const s = S.sale(r.sale_date, r.sale_price);
      if (s) rec.sales.push(s);
      if (S.num(r.total_area)) {
        rec.acres = r.total_area / 43560;
        rec.acresLabel = 'land area';
      }
      rec.details.push(['Market value', S.money(r.market_value)], ['Year built', U.clean(r.year_built)], ['Category', U.clean(r.category_code_description)], ['Zoning', U.clean(r.zoning)]);
    },
  },
  {
    id: 'dc',
    name: 'District of Columbia owner polygons',
    publisher: 'DC Office of the Chief Technology Officer / Office of Tax and Revenue',
    homepage: 'https://opendata.dc.gov/',
    region: 'Washington, DC',
    bbox: [-77.12, 38.79, -76.90, 39.0],
    counties: ['11001'],
    level: 'sales',
    type: 'arcgis',
    url: ESRI('https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Property_and_Land_WebMercator/MapServer/40'),
    note: 'DC publishes the current owner and the most recent sale.',
    normalize(a) {
      return {
        owners: S.owners(a.OWNERNAME, a.OWNNAME2),
        parcelId: U.clean(a.SSL) ? `SSL ${a.SSL}` : null,
        address: S.join(a.PREMISEADD),
        place: 'Washington, DC',
        acres: S.num(a.LANDAREA) ? a.LANDAREA / 43560 : null,
        acresLabel: 'land area',
        sales: S.sales(S.sale(a.SALEDATE, a.SALEPRICE, { note: U.clean(a.SALETYPE) })),
        details: [
          ['Assessed value', S.money(a.ASSESSMENT)],
          ['Use', U.clean(a.USECODE)],
          ['Deed reference', U.clean(a.DEEDS)],
        ],
      };
    },
  },
  {
    id: 'cook',
    name: 'Cook County parcels + Assessor sales',
    publisher: 'Cook County GIS; Cook County Assessor’s Office',
    homepage: 'https://datacatalog.cookcountyil.gov/',
    region: 'Cook County, IL (Chicago)',
    bbox: [-88.27, 41.46, -87.52, 42.16],
    counties: ['17031'],
    level: 'history',
    type: 'arcgis',
    url: ESRI('https://gis.cookcountyil.gov/traditional/rest/services/parcelHistorical/MapServer/2024'),
    history: 'cook-sales',
    note: 'Every sale since 1999 with date, price, buyer and seller, from the Assessor’s sales file. The current owner shown is the taxpayer name on the tax bill.',
    normalize(a) {
      const pin = U.clean(a.Name);
      return {
        owners: [],
        parcelId: pin ? `PIN ${pin.replace(/^(\d\d)(\d\d)(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3-$4-$5')}` : null,
        place: U.clean(a.MUNICIPALITY),
        keys: { pin },
        link: pin ? { url: `https://www.cookcountyassessor.com/pin/${pin}`, label: 'Cook County Assessor record' } : null,
        details: [['Township', U.clean(a.PoliticalTownship)], ['Tax code', U.clean(a.TAXCODE)]],
      };
    },
    async enrich(rec, signal) {
      if (!rec.keys.pin) return;
      const j = await U.fetchJSON(`https://datacatalog.cookcountyil.gov/resource/3723-97qp.json?pin=${rec.keys.pin}&$order=year%20DESC&$limit=1`, { signal });
      const r = j[0];
      if (!r) return;
      rec.owners = S.owners(r.owner_address_name || r.mail_address_name);
      rec.ownerLabel = 'Taxpayer of record';
      rec.address = S.join(r.prop_address_full) || rec.address;
      if (r.prop_address_city_name) rec.place = r.prop_address_city_name;
    },
  },
  {
    id: 'franklin-oh',
    name: 'Franklin County (Columbus) Auditor parcels',
    publisher: 'Franklin County Auditor, Ohio',
    homepage: 'https://gis.franklincountyohio.gov/',
    region: 'Franklin County, OH (Columbus)',
    bbox: [-83.26, 39.80, -82.76, 40.14],
    counties: ['39049'],
    level: 'owner',
    type: 'arcgis',
    url: ESRI('https://gis.franklincountyohio.gov/hosting/rest/services/ParcelFeatures/TaxParcel_EDP/FeatureServer/0'),
    normalize(a) {
      return {
        owners: S.owners(a.OWNERNME1, a.OWNERNME2, a.OWNERNME3),
        parcelId: U.clean(a.PARCELID),
        address: U.clean(a.SITEADDRESS),
        details: [],
      };
    },
  },

  /* ---------------- Statewide sources ---------------- */
  {
    id: 'md',
    name: 'Maryland parcels + SDAT real property records',
    publisher: 'Maryland Dept. of Planning; State Dept. of Assessments and Taxation',
    homepage: 'https://imap.maryland.gov/',
    states: ['MD'],
    level: 'history',
    type: 'arcgis',
    url: ESRI('https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_ParcelBoundaries/MapServer/0'),
    history: 'md-sdat',
    note: 'Maryland publishes the last three transfers (date, price and the seller’s name) but hides current owner names from open data. Follow the SDAT link to see the owner.',
    normalize(a) {
      return {
        owners: [],
        ownerNote: 'Maryland removes owner names from its open data. The state’s SDAT record (linked below) shows the current owner.',
        parcelId: U.clean(a.ACCTID) ? `Account ${a.ACCTID}` : null,
        address: U.clean(a.ADDRESS),
        place: U.clean(a.CITY),
        acres: S.num(a.ACRES),
        acresLabel: 'assessed',
        sales: S.sales(S.sale(a.TRADATE, a.CONSIDR1)),
        keys: { acctid: U.clean(a.ACCTID) },
        link: U.clean(a.SDATWEBADR) ? { url: a.SDATWEBADR, label: 'Maryland SDAT record (shows owner)' } : null,
        details: [['Year built', U.clean(a.YEARBLT)], ['Land use', U.clean(a.DESCLU)], ['Market value', S.money(a.NFMTTLVL)]],
      };
    },
  },
  {
    id: 'ct',
    name: 'Connecticut CAMA and Parcel Layer + Real Estate Sales',
    publisher: 'State of Connecticut Office of Policy and Management',
    homepage: 'https://portal.ct.gov/opm/igpp/data-sharing/parcel-and-cama-data',
    states: ['CT'],
    level: 'history',
    type: 'arcgis',
    url: ESRI('https://services3.arcgis.com/3FL1kr7L4LvwA2Kb/ArcGIS/rest/services/Connecticut_CAMA_and_Parcel_Layer/FeatureServer/0'),
    history: 'ct-sales',
    note: 'Current owner plus the last two sales from town assessors, and every recorded sale since 2001 (dates and prices, no names) from the state sales list.',
    normalize(a) {
      return {
        owners: S.owners(a.Owner, a.Co_Owner),
        parcelId: U.clean(a.Parcel_ID),
        address: U.clean(a.Location_1) || U.clean(a.Location),
        place: U.clean(a.Property_City) || U.clean(a.Town_Name),
        acres: S.num(a.Land_Acres),
        acresLabel: 'assessor',
        sales: S.sales(S.sale(a.Sale_Date, a.Sale_Price), S.sale(a.Prior_Sale_Date, a.Prior_Sale_Price, { book: U.clean(a.Prior_Book_Page) })),
        keys: { town: U.clean(a.Town_Name) || U.clean(a.Property_City), address: U.clean(a.Location_1) || U.clean(a.Location) },
        details: [
          ['Assessed value', S.money(a.Assessed_Total)],
          ['Use', U.clean(a.State_Use_Description)],
          ['Living area', S.num(a.Living_Area) ? `${Number(a.Living_Area).toLocaleString()} sq ft` : null],
          ['Zoning', U.clean(a.Zone)],
          // Some towns record the prior sale's price and deed but not its date.
          ['Prior sale price', U.parseDate(a.Prior_Sale_Date) ? null : S.money(a.Prior_Sale_Price)],
          ['Prior deed (book/page)', U.clean(a.Prior_Book_Page)],
        ],
      };
    },
  },
  {
    id: 'ma',
    name: 'MassGIS Property Tax Parcels',
    publisher: 'MassGIS (Bureau of Geographic Information)',
    homepage: 'https://www.mass.gov/info-details/massgis-data-property-tax-parcels',
    states: ['MA'],
    level: 'sales',
    type: 'arcgis',
    url: ESRI('https://services1.arcgis.com/hGdibHYSPO59RG1h/ArcGIS/rest/services/Massachusetts_Property_Tax_Parcels/FeatureServer/0'),
    note: 'Current owner and the most recent sale (date, price, deed book/page) from town assessors.',
    normalize(a) {
      const unit = String(a.LOT_UNITS || '').toLowerCase();
      const lot = S.num(a.LOT_SIZE);
      return {
        owners: S.owners(a.OWNER1),
        parcelId: U.clean(a.MAP_PAR_ID) || U.clean(a.LOC_ID),
        address: U.clean(a.SITE_ADDR),
        place: U.clean(a.CITY),
        acres: lot ? (unit.startsWith('s') ? lot / 43560 : lot) : null,
        acresLabel: 'assessor',
        sales: S.sales(S.sale(a.LS_DATE, a.LS_PRICE, { book: a.LS_BOOK ? `Book ${a.LS_BOOK}, Page ${a.LS_PAGE}` : null })),
        details: [
          ['Total value', S.money(a.TOTAL_VAL)],
          ['Use', U.clean(a.USE_DESC)],
          ['Year built', U.clean(a.YEAR_BUILT)],
          ['Assessment year', U.clean(a.FY)],
        ],
      };
    },
  },
  {
    id: 'co',
    name: 'Colorado Public Parcels',
    publisher: 'Colorado Governor’s Office of Information Technology (from county assessors)',
    homepage: 'https://geodata.colorado.gov/',
    states: ['CO'],
    level: 'sales',
    type: 'arcgis',
    url: ESRI('https://gis.colorado.gov/Public/rest/services/Address_and_Parcel/Colorado_Public_Parcels/MapServer/0'),
    note: 'Current owner and most recent sale from counties that share data with the state.',
    normalize(a) {
      return {
        owners: S.owners(a.owner, a.owner2),
        parcelId: U.clean(a.parcel_id),
        address: U.clean(a.situsAdd),
        place: U.clean(a.sitAddCty),
        acres: S.num(a.landAcres) || (S.num(a.landSqft) ? a.landSqft / 43560 : null),
        acresLabel: 'assessor',
        sales: S.sales(S.sale(a.saleDate, a.salePrice)),
        link: U.clean(a.URL) && /^https?:/.test(a.URL) ? { url: a.URL, label: 'County assessor record' } : null,
        details: [
          ['Appraised value', S.money(a.apprValTot)],
          ['Land use', U.clean(a.landUseDsc)],
          ['Subdivision', U.clean(a.subName)],
          ['Legal description', U.clean(a.legalDesc)],
        ],
      };
    },
  },
  {
    id: 'mn',
    name: 'Open Parcels in Minnesota',
    publisher: 'Minnesota Geospatial Information Office (opt-in counties)',
    homepage: 'https://gisdata.mn.gov/dataset/plan-parcels-open',
    states: ['MN'],
    level: 'sales',
    type: 'arcgis',
    url: ESRI('https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_mngeo/plan_parcels_open/FeatureServer/0'),
    note: 'Only counties that opted in to open data are included. Shows owner and most recent sale.',
    normalize(a) {
      return {
        owners: S.owners(a.owner_name, a.owner_more).length ? S.owners(a.owner_name, a.owner_more) : S.owners(a.tax_name),
        parcelId: U.clean(a.county_pin) || U.clean(a.state_pin),
        address: S.join([a.anumber, a.st_pre_dir, a.st_name, a.st_pos_typ].map(U.clean).filter(Boolean).join(' ')),
        place: U.clean(a.ctu_name) || U.clean(a.postcomm),
        acres: S.num(a.acres_deed) || S.num(a.acres_poly),
        acresLabel: S.num(a.acres_deed) ? 'deeded' : 'mapped',
        sales: S.sales(S.sale(a.sale_date, a.sale_value)),
        details: [
          ['Total value', S.money(a.total_val) || S.money(a.emv_total)],
          ['Year built', U.clean(a.year_built)],
          ['County', U.clean(a.co_name)],
        ],
      };
    },
  },
  {
    id: 'nc',
    name: 'NC OneMap statewide parcels',
    publisher: 'North Carolina Center for Geographic Information & Analysis (from all 100 counties)',
    homepage: 'https://www.nconemap.gov/',
    states: ['NC'],
    level: 'sales',
    type: 'arcgis',
    url: ESRI('https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1'),
    note: 'Current owner and the date of the most recent sale (prices are not part of the statewide layer).',
    normalize(a) {
      return {
        owners: S.owners(a.ownname, a.ownname2),
        parcelId: U.clean(a.parno),
        address: U.clean(a.siteadd),
        place: U.clean(a.scity),
        acres: S.num(a.gisacres),
        acresLabel: 'GIS',
        sales: S.sales(S.sale(S.pick(a, ['saledate', 'saledatetx']), null, { book: U.clean(a.sourceref) })),
        details: [
          ['Total value', S.money(a.parval)],
          ['Year built', U.clean(a.structyear)],
          ['Legal description', U.clean(a.legdecfull)],
          ['County', U.clean(a.cntyname)],
        ],
      };
    },
  },
  {
    id: 'tx',
    name: 'StratMap Land Parcels (Texas)',
    publisher: 'Texas Geographic Information Office (from county appraisal districts)',
    homepage: 'https://geographic.texas.gov/',
    states: ['TX'],
    level: 'owner',
    type: 'arcgis-identify',
    url: ESRI('https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer'),
    layerId: 0,
    draw: 'image',
    note: 'Owner names from county appraisal districts. Texas is a non-disclosure state, so sale prices are never public, and the statewide layer has no sale dates. Deeds are at each county clerk.',
    normalize(a) {
      const legal = S.num(a.LEGAL_AREA);
      return {
        owners: S.owners(a.OWNER_NAME),
        parcelId: U.clean(a.PROP_ID) ? `Prop ID ${a.PROP_ID}` : U.clean(a.GEO_ID),
        address: U.clean(a.SITUS_ADDR)?.replace(/,\s*,/g, ','),
        place: U.clean(a.SITUS_CITY),
        acres: legal && (!U.clean(a.LGL_AREA_UNIT) || /ac/i.test(a.LGL_AREA_UNIT)) ? legal : null,
        acresLabel: 'legal',
        details: [
          ['Market value', S.money(a.MKT_VALUE)],
          ['Legal description', U.clean(a.LEGAL_DESC)],
          ['Appraisal district', U.clean(a.SOURCE)],
          ['Tax year', U.clean(a.TAX_YEAR)],
          // DATE_ACQ is when the state collected the county's data, not when the owner bought it.
          ['Data collected', U.fmtDate(U.parseDate(U.clean(a.DATE_ACQ)))],
        ],
      };
    },
  },
  {
    id: 'wi',
    name: 'Wisconsin Statewide Parcels (V12)',
    publisher: 'Wisconsin State Cartographer’s Office / Dept. of Administration',
    homepage: 'https://www.sco.wisc.edu/parcels/data/',
    states: ['WI'],
    level: 'owner',
    type: 'arcgis',
    url: ESRI('https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer/0'),
    note: 'Owner names from local tax rolls (a few municipalities opt out). No sale history in the statewide layer.',
    normalize(a) {
      return {
        owners: S.owners(a.OWNERNME1, a.OWNERNME2),
        parcelId: U.clean(a.PARCELID) || U.clean(a.STATEID),
        address: U.clean(a.SITEADRESS),
        place: U.clean(a.PLACENAME),
        acres: S.num(a.DEEDACRES) || S.num(a.ASSDACRES) || S.num(a.GISACRES),
        acresLabel: S.num(a.DEEDACRES) ? 'deeded' : S.num(a.ASSDACRES) ? 'assessed' : 'GIS',
        details: [
          ['Assessed value', S.money(a.CNTASSDVALUE)],
          ['Est. market value', S.money(a.ESTFMKVALUE)],
          ['Tax roll year', U.clean(a.TAXROLLYEAR)],
          ['County', U.clean(a.CONAME)],
        ],
      };
    },
  },
  {
    id: 'fl',
    name: 'Florida statewide parcels (Dept. of Revenue tax roll)',
    publisher: 'Florida Dept. of Agriculture & Consumer Services (from FL Dept. of Revenue)',
    homepage: 'https://floridarevenue.com/property/dataportal/',
    states: ['FL'],
    level: 'owner',
    type: 'arcgis',
    url: ESRI('https://gis.fdacs.gov/mapping/rest/services/GIO_Parcels_for_OAWP_Optimized/FeatureServer/0'),
    note: 'Owner names from the statewide tax roll. Sale history is kept by each county property appraiser (follow the county link).',
    normalize(a) {
      return {
        owners: S.owners(a.OWN_NAME),
        parcelId: U.clean(a.PARCEL_ID),
        details: [['Just (market) value', S.money(a.JV_CLASS_U)], ['Agricultural exemption', U.clean(a.AgTaxExempt)]],
      };
    },
  },
  {
    id: 'mt',
    name: 'Montana Cadastral Framework',
    publisher: 'Montana State Library / Dept. of Revenue',
    homepage: 'https://msl.mt.gov/geoinfo/msdi/cadastral/',
    states: ['MT'],
    level: 'owner',
    type: 'arcgis',
    url: ESRI('https://gisservice.mt.gov/ArcGIS/rest/services/msdi_cadastral_map_v1/MapServer/1'),
    note: 'Owner names from the Dept. of Revenue. No sale data.',
    normalize(a) {
      return {
        owners: S.owners(a.OwnerName),
        parcelId: U.clean(a.PARCELID),
        address: U.clean(a.AddressLine1),
        place: U.clean(a.CityStateZip),
        acres: S.num(a.TotalAcres) || S.num(a.GISAcres),
        acresLabel: S.num(a.TotalAcres) ? 'assessed' : 'GIS',
        details: [['Total value', S.money(a.TotalValue)], ['County', U.clean(a.CountyName)], ['Legal description', U.clean(a.LegalDescriptionShort)]],
      };
    },
  },
  {
    id: 'vt',
    name: 'Vermont standardized parcels',
    publisher: 'Vermont Center for Geographic Information (from town grand lists)',
    homepage: 'https://vcgi.vermont.gov/',
    states: ['VT'],
    level: 'owner',
    type: 'arcgis',
    url: ESRI('https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Cadastral_VTPARCELS_poly_standardized_parcels_SP_v1/FeatureServer/0'),
    note: 'Owner names from each town’s grand list. No sale data.',
    normalize(a) {
      return {
        owners: S.owners(a.OWNER1, a.OWNER2),
        parcelId: U.clean(a.SPAN),
        address: U.clean(a.E911ADDR),
        place: U.clean(a.TNAME),
        acres: S.num(a.ACRESGL),
        acresLabel: 'grand list',
        details: [['Real estate value', S.money(a.REAL_FLV)], ['Description', U.clean(a.DESCPROP)], ['Grand list year', U.clean(a.GLYEAR)]],
      };
    },
  },
  {
    id: 'ar',
    name: 'Arkansas statewide parcels (CAMP)',
    publisher: 'Arkansas GIS Office',
    homepage: 'https://gis.arkansas.gov/',
    states: ['AR'],
    level: 'owner',
    type: 'arcgis',
    url: ESRI('https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Planning_Cadastre/FeatureServer/6'),
    note: 'Owner names from county assessors. The source deed reference is shown when the county provides it.',
    normalize(a) {
      return {
        owners: S.owners(a.ownername),
        parcelId: U.clean(a.parcelid),
        address: U.clean(a.adrlabel),
        place: U.clean(a.adrcity),
        acres: S.num(a.taxarea),
        acresLabel: 'tax',
        details: [
          ['Total value', S.money(a.totalvalue)],
          ['Legal description', U.clean(a.parcellgl)],
          ['Deed reference', U.clean(a.sourceref)],
          ['Deed reference date', U.fmtDate(U.parseDate(a.sourcedate, 'epoch'))],
          ['County', U.clean(a.county)],
        ],
      };
    },
  },
  {
    id: 'nj',
    name: 'New Jersey statewide parcels with MOD-IV tax data',
    publisher: 'NJ Office of GIS',
    homepage: 'https://nj.gov/njgin/edata/parcels/',
    states: ['NJ'],
    level: 'lines',
    type: 'arcgis',
    url: ESRI('https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0'),
    note: 'Owner names are redacted statewide under Daniel’s Law. The last deed date and sale price are still published.',
    normalize(a) {
      return {
        owners: S.owners(a.OWNER_NAME),
        ownerNote: 'New Jersey redacts owner names from public map data under Daniel’s Law. The county clerk’s deed records still name the owner.',
        parcelId: U.clean(a.PAMS_PIN),
        address: U.clean(a.PROP_LOC),
        place: U.clean(a.MUN_NAME),
        acres: S.num(a.CALC_ACRE),
        acresLabel: 'calculated',
        sales: S.sales(S.sale(a.DEED_DATE, a.SALE_PRICE, { hint: 'yymmdd', book: a.DEED_BOOK ? `Book ${a.DEED_BOOK}, Page ${a.DEED_PAGE}` : null })),
        details: [['Net assessed value', S.money(a.NET_VALUE)], ['Year built', U.clean(a.YR_CONSTR)], ['Last year’s tax', S.money(a.LAST_YR_TX)], ['County', U.clean(a.COUNTY)]],
      };
    },
  },
  {
    id: 'wa',
    name: 'Washington State Parcels Project',
    publisher: 'WA Dept. of Fish & Wildlife / WA Technology Solutions',
    homepage: 'https://geo.wa.gov/',
    states: ['WA'],
    level: 'lines',
    type: 'arcgis',
    url: ESRI('https://geodataservices.wdfw.wa.gov/arcgis/rest/services/MapServices/Parcels/FeatureServer/0'),
    note: 'Boundaries statewide. Owners are on each county assessor’s site, linked from every parcel.',
    normalize(a) {
      return {
        owners: [],
        ownerNote: 'Washington’s statewide layer doesn’t carry owner names. The county assessor link below opens this parcel’s record with the owner.',
        parcelId: U.clean(a.ORIG_PARCEL_ID) || U.clean(a.PARCEL_ID_NR),
        link: U.clean(a.DATA_LINK) ? { url: a.DATA_LINK, label: `${a.COUNTY_NM || 'County'} assessor record` } : null,
        details: [],
      };
    },
  },
  {
    id: 'in',
    name: 'Parcel Boundaries of Indiana',
    publisher: 'Indiana Geographic Information Office (Data Harvest)',
    homepage: 'https://www.in.gov/gis/',
    states: ['IN'],
    level: 'lines',
    type: 'arcgis',
    url: ESRI('https://gisdata.in.gov/server/rest/services/Hosted/Parcel_Boundaries_of_Indiana_Current/FeatureServer/0'),
    note: 'Boundaries and parcel numbers only.',
    normalize(a) {
      return {
        owners: [],
        ownerNote: 'Indiana’s statewide layer has boundaries and parcel numbers but no owner names.',
        parcelId: U.clean(a.parcel_id) || U.clean(a.state_parcel_id),
        address: U.clean(a.dlgf_prop_address) || U.clean(a.prop_add),
        place: U.clean(a.dlgf_prop_address_city) || U.clean(a.esri_poname),
        details: [['Source', U.clean(a.source_originator)]],
      };
    },
  },
  {
    id: 'va',
    name: 'Virginia Parcels (VGIN)',
    publisher: 'Virginia Geographic Information Network',
    homepage: 'https://vgin.vdem.virginia.gov/',
    states: ['VA'],
    level: 'lines',
    type: 'arcgis',
    url: ESRI('https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels/FeatureServer/0'),
    note: 'Boundaries and parcel IDs only.',
    normalize(a) {
      return {
        owners: [],
        ownerNote: 'Virginia’s statewide layer has boundaries and parcel IDs only.',
        parcelId: U.clean(a.PARCELID),
        place: U.clean(a.LOCALITY),
        details: [],
      };
    },
  },
  {
    id: 'ut',
    name: 'Utah statewide parcels (LIR)',
    publisher: 'Utah Geospatial Resource Center',
    homepage: 'https://gis.utah.gov/products/sgid/cadastre/',
    states: ['UT'],
    level: 'lines',
    type: 'arcgis',
    url: ESRI('https://services1.arcgis.com/99lidPhWCzftIe9K/ArcGIS/rest/services/Parcels_Utah_LIR/FeatureServer/0'),
    note: 'Boundaries, addresses and values. Utah counties keep owner names on their own sites.',
    normalize(a) {
      return {
        owners: [],
        ownerNote: 'Utah’s statewide layer leaves out owner names. The county recorder (linked below) has them.',
        parcelId: U.clean(a.PARCEL_ID),
        address: U.clean(a.PARCEL_ADD),
        place: U.clean(a.PARCEL_CITY),
        acres: S.num(a.PARCEL_ACRES),
        acresLabel: 'assessor',
        link: U.clean(a.BOUNDARY_SRC) ? { url: a.BOUNDARY_SRC, label: `${a.COUNTY_NAME || 'County'} recorder` } : null,
        details: [['Market value', S.money(a.TOTAL_MKT_VALUE)], ['Year built', U.clean(a.BUILT_YR)], ['Property class', U.clean(a.PROP_CLASS)]],
      };
    },
  },
  {
    id: 'de',
    name: 'Delaware State Parcels (FirstMap)',
    publisher: 'Delaware FirstMap',
    homepage: 'https://firstmap.delaware.gov/',
    states: ['DE'],
    level: 'lines',
    type: 'arcgis',
    url: ESRI('https://enterprise.firstmap.delaware.gov/arcgis/rest/services/PlanningCadastre/DE_StateParcels/FeatureServer/0'),
    note: 'Boundaries and parcel numbers only.',
    normalize(a) {
      return {
        owners: [],
        ownerNote: 'Delaware’s statewide layer has boundaries and parcel numbers only.',
        parcelId: U.clean(a.PIN),
        acres: S.num(a.ACRES),
        acresLabel: 'mapped',
        details: [['County', U.clean(a.COUNTY)]],
      };
    },
  },
];

/* Federal / state / local public & protected land, nationwide (USGS PAD-US 4.1). */
const PADUS = {
  name: 'Protected Areas Database of the United States (PAD-US 4.1)',
  publisher: 'U.S. Geological Survey Gap Analysis Project',
  homepage: 'https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-overview',
  url: 'https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/Manager_Name_PADUS/FeatureServer/0',
};

/* County lookup (name + FIPS) for any point in the country. */
const COUNTIES_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1';

const LEVELS = {
  history: { label: 'Owners + sale history', color: '#1b7f4b' },
  sales: { label: 'Owners + latest sale', color: '#52b35c' },
  owner: { label: 'Owner names', color: '#a7d676' },
  lines: { label: 'Property lines only', color: '#6a9fd4' },
  none: { label: 'No free parcel data (public lands only)', color: '#d9d4c7' },
};

/*
 * County sources described as data (js/counties-*.js) instead of code. Each entry gives the
 * service URL and which of its fields hold the owner, parcel ID, address, size and last sale:
 *
 *   { id, st, county, fips, url, publisher, bbox, outline,
 *     f: { owner: [...], id: [...], addr: [...], city: [...], acres: [...], sqft: [...],
 *          saleDate: [...], salePrice: [...], link: 'FIELD', details: [[field, label, 'money'?], ...] } }
 */
/* Standard property classes: Michigan uses 3-digit codes (401 = residential, improved), Iowa uses letters. */
const MI_CLASS = { 1: 'Agricultural', 2: 'Commercial', 3: 'Industrial', 4: 'Residential', 5: 'Timber-cutover', 6: 'Developmental', 7: 'Exempt' };
const IA_CLASS = { A: 'Agricultural', R: 'Residential', C: 'Commercial', I: 'Industrial', M: 'Multi-residential', E: 'Exempt', U: 'Utility', RR: 'Railroad' };
function describeClass(st, v) {
  const s = String(v).trim();
  if (st === 'MI' && /^[1-7]0[0-9]$/.test(s)) {
    const kind = s.endsWith('01') ? ', improved' : s.endsWith('02') ? ', vacant' : '';
    return `${MI_CLASS[s[0]]}${kind} (${s})`;
  }
  if (st === 'IA' && IA_CLASS[s.toUpperCase()]) return `${IA_CLASS[s.toUpperCase()]} (${s})`;
  return s;
}
/* Some services store text base64-encoded; decode it when it clearly is. */
function maybeBase64(v) {
  const s = String(v).trim();
  if (s.length < 16 || s.length % 4 || /\s/.test(s) || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || /^\d+$/.test(s)) return s;
  try {
    const d = atob(s);
    return /^[\x20-\x7e]+$/.test(d) ? d.trim() : s;
  } catch {
    return s;
  }
}
const GUID_RE = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;

function fromFieldMap(c) {
  const f = c.f;
  const first = (a, list, ok = () => true) => {
    for (const k of list || []) if (U.clean(a[k]) !== null && ok(String(a[k]).trim())) return a[k];
    return null;
  };
  const stateName = { MI: 'Michigan', IA: 'Iowa' }[c.st] || c.st;
  const hasDate = !!(f.saleDate && f.saleDate.length);
  const hasSale = hasDate || (f.salePrice && f.salePrice.length);
  const by = c.publisher ? ` (published by ${c.publisher})` : '';
  let note = hasSale
    ? `Current owner and most recent sale from a public parcel service${by}.`
    : `Current owner from a public parcel service${by}. No sale history is published there.`;
  if (c.partial) note += ` This layer covers only part of ${c.county} County${c.partial === true ? '' : ` (${c.partial})`}.`;
  if (c.asOf) note += ` Its records are as of ${c.asOf}, so newer sales and owners may be missing.`;
  return {
    id: c.id,
    name: `${c.county} County, ${stateName} parcels${c.partial ? ' (partial)' : ''}`,
    publisher: c.publisher || `${c.county} County, ${stateName}`,
    homepage: c.home || c.url,
    region: `${c.county} County, ${c.st}`,
    bbox: c.bbox,
    outline: c.outline,
    partial: c.partial || false,
    asOf: c.asOf || null,
    counties: [c.fips],
    level: hasSale ? 'sales' : 'owner',
    type: 'arcgis',
    url: c.url,
    note,
    normalize(a) {
      let addr = U.clean(first(a, f.addr));
      if (!addr && f.addrParts) {
        const parts = f.addrParts.map((k) => U.clean(a[k])).filter(Boolean);
        addr = parts.length === f.addrParts.length ? parts.join(' ') : null;
      }
      const acres = S.num(first(a, f.acres));
      const sqft = S.num(first(a, f.sqft));
      const linkVal = f.link ? String(a[f.link] || '') : '';
      const details = (f.details || []).map(([k, label, kind]) => {
        if (kind === 'money') return [label, S.money(a[k])];
        const v = U.clean(a[k]);
        if (v === null) return [label, null];
        return [label, label === 'Property class' ? describeClass(c.st, v) : maybeBase64(v)];
      });
      // A sale price with no date can't go on the timeline, so show it as a detail.
      if (!hasDate && f.salePrice) details.unshift(['Last sale price', S.money(first(a, f.salePrice))]);
      return {
        owners: S.owners(...(f.owner || []).map((k) => a[k])),
        ownerLabel: f.ownerLabel || null,
        parcelId: U.clean(first(a, f.id, (v) => !GUID_RE.test(v))),
        address: addr && /[A-Za-z]/.test(addr) ? addr : null,
        place: (U.clean(first(a, f.city, (v) => /[A-Za-z]{3}/.test(v) && !/^,/.test(v))) || '')
          .replace(/,?\s*(MI|IA|Michigan|Iowa)\.?\s*(\d{5}(-\d{4})?)?\s*$/i, '')
          .replace(/,?\s*\d{5}(-\d{4})?\s*$/, '') || null,
        acres: acres || (sqft ? sqft / 43560 : null),
        acresLabel: acres || sqft ? 'county record' : null,
        sales: hasDate ? S.sales(S.sale(first(a, f.saleDate), first(a, f.salePrice), { sellers: S.owners(first(a, f.seller)) })) : [],
        link: /^https?:\/\//i.test(linkVal) ? { url: linkVal, label: `${c.county} County property record` } : null,
        details,
      };
    },
  };
}
if (window.COUNTY_SOURCES) SOURCES.unshift(...window.COUNTY_SOURCES.map(fromFieldMap));

/* Precompute coverage boxes. */
for (const s of SOURCES) {
  if (!s.bbox && s.states) {
    const boxes = s.states.map(U.stateBBox).filter(Boolean);
    s.bbox = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  }
  s.draw = s.draw || 'vector';
  s.minZoom = s.minZoom || (s.draw === 'image' ? 15 : 16);
}
