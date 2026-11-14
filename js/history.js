/*
 * Ownership-history providers. Each takes a normalized parcel record and returns a list of
 * transfer events:  { date, price, sellers: [], buyers: [], docType, book, note }
 * All sources are free public open-data APIs (no keys).
 */
'use strict';

const SOCRATA_NYC = 'https://data.cityofnewyork.us/resource/';

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const HISTORY = {
  /* New York City: ACRIS (Automated City Register Information System). */
  async acris(rec, signal) {
    const { boro, block, lot } = rec.keys || {};
    if (!boro || !block || !lot) return [];
    const legals = await U.fetchJSON(
      `${SOCRATA_NYC}8h5j-fqxa.json?${U.qs({ borough: boro, block, lot, $select: 'document_id', $limit: 5000 })}`,
      { signal, timeout: 45000 }
    );
    const ids = [...new Set(legals.map((r) => r.document_id))];
    if (!ids.length) return [];

    const inList = (c) => c.map((id) => `'${id.replace(/'/g, '')}'`).join(',');
    const masters = (
      await Promise.all(
        chunk(ids, 60).map((c) =>
          U.fetchJSON(
            `${SOCRATA_NYC}bnx9-e6tj.json?${U.qs({
              $where: `document_id in (${inList(c)}) AND starts_with(doc_type,'DEED')`,
              $select: 'document_id,doc_type,document_date,recorded_datetime,document_amt,crfn,percent_trans',
              $limit: 5000,
            })}`,
            { signal, timeout: 45000 }
          )
        )
      )
    ).flat();
    if (!masters.length) return [];

    const deedIds = [...new Set(masters.map((m) => m.document_id))];
    const parties = (
      await Promise.all(
        chunk(deedIds, 60).map((c) =>
          U.fetchJSON(
            `${SOCRATA_NYC}636b-3b5g.json?${U.qs({ $where: `document_id in (${inList(c)})`, $select: 'document_id,party_type,name', $limit: 5000 })}`,
            { signal, timeout: 45000 }
          )
        )
      )
    ).flat();

    const byDoc = {};
    for (const p of parties) {
      const d = (byDoc[p.document_id] ||= { sellers: [], buyers: [] });
      const n = U.name(p.name);
      if (!n) continue;
      if (p.party_type === '1' && !d.sellers.includes(n)) d.sellers.push(n);
      if (p.party_type === '2' && !d.buyers.includes(n)) d.buyers.push(n);
    }

    const DOC_LABELS = { DEED: 'Deed', DEEDO: 'Deed (other)', 'DEED, LE': 'Life estate deed', 'DEED, RC': 'Deed (referee/court)', 'DEED, TS': 'Timeshare deed' };
    return masters.map((m) => ({
      date: U.parseDate(m.document_date) || U.parseDate(m.recorded_datetime),
      recorded: U.parseDate(m.recorded_datetime),
      price: U.parseMoney(m.document_amt),
      sellers: byDoc[m.document_id]?.sellers || [],
      buyers: byDoc[m.document_id]?.buyers || [],
      docType: DOC_LABELS[m.doc_type] || m.doc_type,
      book: m.crfn ? `CRFN ${m.crfn}` : null,
      note: m.percent_trans && +m.percent_trans > 0 && +m.percent_trans < 100 ? `${+m.percent_trans}% interest transferred` : null,
    }));
  },

  /* Philadelphia: Realty Transfer Tax summary (Dept. of Records). */
  async 'phl-rtt'(rec, signal) {
    const opa = rec.keys?.opa;
    if (!opa) return [];
    const sql = `SELECT document_type, display_date, recording_date, grantors, grantees, total_consideration, document_id FROM rtt_summary WHERE opa_account_num='${opa.replace(/'/g, '')}' AND document_type ILIKE 'DEED%' ORDER BY display_date`;
    const j = await U.fetchJSON(`https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(sql)}`, { signal, timeout: 45000 });
    return (j.rows || []).map((r) => ({
      date: U.parseDate(r.display_date) || U.parseDate(r.recording_date),
      recorded: U.parseDate(r.recording_date),
      price: U.parseMoney(r.total_consideration),
      sellers: U.splitNames(r.grantors),
      buyers: U.splitNames(r.grantees),
      docType: r.document_type ? r.document_type.charAt(0) + r.document_type.slice(1).toLowerCase() : 'Deed',
      book: r.document_id ? `Doc ${r.document_id}` : null,
    }));
  },

  /* Maryland: SDAT real property file — last three transfers with the seller (grantor). */
  async 'md-sdat'(rec, signal) {
    const acct = rec.keys?.acctid;
    if (!acct) return [];
    const rows = await U.fetchJSON(`https://opendata.maryland.gov/resource/ed4q-f8tm.json?account_id_mdp_field_acctid=${encodeURIComponent(acct)}&$limit=1`, { signal });
    const row = rows[0];
    if (!row) return [];
    const get = (re) => {
      const k = Object.keys(row).find((key) => re.test(key));
      return k ? row[k] : null;
    };
    const events = [];
    for (const n of [1, 2, 3]) {
      const date = U.parseDate(get(new RegExp(`^sales_segment_${n}_transfer_date`)));
      const price = U.parseMoney(get(new RegExp(`^sales_segment_${n}_consideration`)));
      const grantor = U.name(get(new RegExp(`^sales_segment_${n}_grantor_name`)));
      const how = U.clean(get(new RegExp(`^sales_segment_${n}_how_conveyed`)));
      const liber = U.clean(get(new RegExp(`^sales_segment_${n}_grantor_deed_reference_1_liber`)));
      const folio = U.clean(get(new RegExp(`^sales_segment_${n}_grantor_deed_reference_1_folio`)));
      if (!date && !grantor) continue;
      events.push({
        date,
        price,
        sellers: grantor ? [grantor] : [],
        buyers: [],
        docType: how && how !== 'No Data' ? how : 'Transfer',
        book: liber ? `Liber ${liber}, Folio ${folio || '?'}` : null,
      });
    }
    return events;
  },

  /* Cook County: Assessor parcel sales (1999+) with buyer & seller names. */
  async 'cook-sales'(rec, signal) {
    const pin = rec.keys?.pin;
    if (!pin) return [];
    const rows = await U.fetchJSON(
      `https://datacatalog.cookcountyil.gov/resource/wvhk-k5uv.json?${U.qs({ pin, $order: 'sale_date', $limit: 500 })}`,
      { signal }
    );
    return rows.map((r) => ({
      date: U.parseDate(r.sale_date),
      price: U.parseMoney(r.sale_price),
      sellers: U.splitNames(r.seller_name, /\s*[;|]\s*/),
      buyers: U.splitNames(r.buyer_name, /\s*[;|]\s*/),
      docType: U.clean(r.deed_type) || U.clean(r.mydec_deed_type) || 'Sale',
      book: r.doc_no ? `Doc ${r.doc_no}` : null,
      note: r.is_multisale === true || r.is_multisale === 'true' ? `Sold together with ${Math.round(+r.num_parcels_sale) || 'other'} parcels` : null,
    }));
  },

  /* Connecticut: OPM Real Estate Sales list (2001+). Dates and prices only (no names). */
  async 'ct-sales'(rec, signal) {
    const { town, address } = rec.keys || {};
    if (!town || !address) return [];
    const esc = (s) => s.toUpperCase().replace(/'/g, "''");
    const rows = await U.fetchJSON(
      `https://data.ct.gov/resource/5mzw-sjtu.json?${U.qs({
        $where: `upper(town)='${esc(town)}' AND upper(address)='${esc(address)}'`,
        $order: 'daterecorded',
        $limit: 200,
      })}`,
      { signal }
    );
    return rows.map((r) => ({
      date: U.parseDate(r.daterecorded),
      price: U.parseMoney(r.saleamount),
      sellers: [],
      buyers: [],
      docType: U.clean(r.propertytype) ? `Sale (${r.propertytype})` : 'Sale',
      note: U.clean(r.nonusecode) ? `Not a market sale: ${String(r.nonusecode).replace(/^\d+\s*-?\s*/, '')}` : null,
    }));
  },
};

const NAME_NOISE = new Set(['THE', 'AND', 'LLC', 'INC', 'TRUST', 'TRUSTEE', 'TRUSTEES', 'ETAL', 'ET', 'AL', 'CO', 'CORP', 'LP', 'LTD', 'REVOCABLE', 'LIVING', 'FAMILY', 'ESTATE', 'OF', 'MRS', 'MR', 'JR', 'SR']);
function nameTokens(list) {
  const t = new Set();
  for (const n of list) for (const w of n.toUpperCase().split(/[^A-Z0-9]+/)) if (w.length >= 3 && !NAME_NOISE.has(w)) t.add(w);
  return t;
}
/* True when two owner lists plausibly name the same people ("SMITH JOHN" vs "John Smith"). */
function namesOverlap(a, b) {
  const ta = nameTokens(a);
  for (const w of nameTokens(b)) if (ta.has(w)) return true;
  return false;
}

/*
 * Merge events from the parcel record and a history provider, then turn them into ownership
 * periods: who owned it, from when, until when, bought for, sold for.
 */
function buildOwnership(rec, events) {
  const all = [...(rec.sales || []).map((s) => ({ sellers: [], buyers: [], ...s })), ...(events || [])].filter((e) => e.date || e.price);

  // De-duplicate: same day (or within 45 days with the same price) is the same transfer.
  all.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
  const merged = [];
  for (const e of all) {
    const twin = merged.find((m) => {
      if (!m.date || !e.date) return false;
      const days = Math.abs(m.date - e.date) / 86400000;
      return days < 1 || (days < 45 && m.price && e.price && Math.abs(m.price - e.price) < 1);
    });
    if (twin) {
      twin.sellers = twin.sellers.length ? twin.sellers : e.sellers;
      twin.buyers = twin.buyers.length ? twin.buyers : e.buyers;
      twin.price = twin.price ?? e.price;
      twin.book = twin.book || e.book;
      twin.docType = twin.docType || e.docType;
      twin.note = twin.note || e.note;
    } else merged.push({ ...e, sellers: [...(e.sellers || [])], buyers: [...(e.buyers || [])] });
  }
  const ev = merged.filter((e) => e.date);

  const periods = [];
  if (ev.length) {
    if (ev[0].sellers.length) {
      periods.push({ owners: ev[0].sellers, from: null, to: ev[0].date, soldFor: ev[0].price, soldEvent: ev[0] });
    }
    ev.forEach((e, i) => {
      const next = ev[i + 1];
      let owners = e.buyers;
      let inferred = false;
      if (!owners.length && next?.sellers.length) {
        owners = next.sellers;
        inferred = true;
      }
      if (!owners.length && !next && rec.owners.length) {
        // The roll's owner may lag the latest sale: if the listed owner is who held it *before* this
        // sale, the new buyer just isn't in the published records yet.
        const prev = periods[periods.length - 1];
        const ownerIsSeller = (e.sellers.length && namesOverlap(rec.owners, e.sellers)) || (prev && prev.owners.length && namesOverlap(rec.owners, prev.owners));
        owners = ownerIsSeller ? [] : rec.owners;
        if (ownerIsSeller) e.buyerPending = true;
      }
      periods.push({
        owners,
        inferred,
        from: e.date,
        boughtFor: e.price,
        boughtEvent: e,
        to: next ? next.date : null,
        soldFor: next ? next.price : null,
        soldEvent: next || null,
        current: !next,
      });
    });
  } else if (rec.acquired || rec.owners.length) {
    periods.push({ owners: rec.owners, from: rec.acquired || null, to: null, current: true });
  }

  // When the record's current owner differs from the last recorded buyer, a newer (unpublished)
  // transfer exists: add the current owner on top with an unknown start date.
  const last = periods[periods.length - 1];
  let rollLags = false;
  if (last && rec.owners.length && last.owners.length && !last.inferred && rec.source.history && !namesOverlap(rec.owners, last.owners)) {
    // Tax rolls often lag deeds: if the roll's owner is an *earlier* owner in the deed history,
    // the latest buyer is the real current owner. Otherwise there is a newer, unpublished transfer.
    rollLags = periods.slice(0, -1).some((p) => namesOverlap(rec.owners, p.owners));
    if (!rollLags) {
      last.current = false;
      periods.push({ owners: rec.owners, from: rec.acquired || null, to: null, current: true, gap: true });
    }
  }
  if (rec.acquired && periods.length && !periods[periods.length - 1].from) periods[periods.length - 1].from = rec.acquired;

  return { events: merged.reverse(), periods: periods.reverse(), rollLags };
}
