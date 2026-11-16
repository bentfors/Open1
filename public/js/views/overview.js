import { get } from '../api.js';
import { h, add, fmtMoney, fmtNum, fmtDate, fmtMonth, fmtShort } from '../dom.js';
import { state } from '../state.js';

const STATUS = {
  missing: ['Ingen tid rapporterad', 'rejected'],
  draft: ['Inte inskickad', 'warn'],
  rejected: ['Avslagen, rätta och skicka in', 'rejected'],
  submitted: ['Inskickad, väntar på attest', 'submitted'],
  approved: ['Attesterad', 'approved'],
  off: ['Ledig', ''],
};

// Ett kort på startsidan: rubrik, ett tydligt värde, en förklaring och en länk dit man gör något åt det.
function card({ title, value, text, link, label, tone }) {
  return h(
    'div',
    { class: `card todo ${tone || ''}` },
    h('div', { class: 'todo-title' }, title),
    value !== undefined ? h('div', { class: 'todo-value' }, value) : null,
    text ? h('div', { class: 'todo-text' }, text) : null,
    link ? h('a', { class: 'btn sm', href: link }, label || 'Öppna') : null,
  );
}

const weekList = (weeks) => weeks.map((c) => `v. ${c.week}`).join(', ');
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const items = (x) => [x.time ? count(x.time, 'tidrad', 'tidrader') : null, x.expense ? count(x.expense, 'utlägg', 'utlägg') : null, x.mileage ? count(x.mileage, 'körning', 'körningar') : null].filter(Boolean).join(', ');

export async function renderOverview(root) {
  const o = await get('/api/overview');
  const cards = [];

  if (o.me) {
    const w = o.me.this_week;
    const [label, cls] = w.status === 'missing' ? ['Inte påbörjad', ''] : STATUS[w.status];
    cards.push(
      card({
        title: `Den här veckan (v. ${w.week})`,
        value: `${fmtNum(w.reported_hours)} av ${fmtNum(w.norm_hours)} h`,
        text: h('span', { class: `chip ${cls}` }, label),
        link: '#/tid',
        label: 'Rapportera tid',
      }),
    );
    if (o.me.late.length) {
      cards.push(
        card({
          title: 'Att skicka in',
          value: String(o.me.late.length),
          text: o.me.late.map((c) => h('div', {}, h('a', { href: `#/tid/${c.start}` }, `v. ${c.week}`), ` · ${STATUS[c.status][0].toLowerCase()}`)),
          tone: 'attention',
        }),
      );
    }
  }
  if (o.rejected) {
    const link = o.rejected.time ? '#/tid' : o.rejected.expense ? '#/utlagg' : '#/korjournal';
    cards.push(card({ title: 'Avslaget att rätta', value: String(o.rejected.time + o.rejected.expense + o.rejected.mileage), text: items(o.rejected), link, label: 'Rätta', tone: 'attention' }));
  }
  if (o.approvals) {
    cards.push(card({ title: 'Att attestera', value: String(o.approvals.total), text: items(o.approvals), link: '#/attest', label: 'Attestera', tone: 'attention' }));
  }
  if (o.team) {
    const c = o.team.counts;
    cards.push(
      card({
        title: o.team.scope === 'all' ? 'Inrapportering, alla' : 'Inrapportering, dina konsulter',
        value: o.team.late_people ? `${o.team.late_people} av ${o.team.people}` : 'Allt inne',
        text: [
          o.team.late_people ? h('div', { class: 'muted' }, 'har veckor som saknas eller inte är inskickade') : h('div', { class: 'muted' }, `${o.team.people} personer, inget saknas de senaste fyra veckorna`),
          ...o.team.late.slice(0, 5).map((p) => h('div', { class: 'small' }, `${p.name}: ${weekList(p.weeks)}`)),
          c.submitted ? h('div', { class: 'small muted' }, `${count(c.submitted, 'vecka väntar', 'veckor väntar')} på attest`) : null,
        ],
        link: '#/rapporter/inrapportering',
        label: 'Se inrapporteringen',
        tone: o.team.late_people ? 'attention' : '',
      }),
    );
  }
  if (o.expiring) {
    cards.push(
      card({
        title: 'Uppdrag som tar slut',
        value: String(o.expiring.length),
        text: o.expiring.map((a) => h('div', { class: 'small' }, `${a.name} hos ${a.customer}, ${fmtShort(a.end_date)}`)),
        link: '#/statistik',
        label: 'Se statistik',
      }),
    );
  }
  if (o.billing) {
    cards.push(
      card({
        title: `Fakturering, ${fmtMonth(o.billing.month)}`,
        value: fmtMoney(o.billing.ready),
        text: o.billing.waiting ? h('span', { class: 'chip warn' }, `${fmtMoney(o.billing.waiting)} väntar på attest`) : 'godkänt och klart att fakturera',
        link: '#/fakturering/manad',
        label: 'Månadsfakturering',
      }),
    );
    cards.push(
      card({
        title: 'Periodlåsning',
        value: o.lock.locked_until ? fmtDate(o.lock.locked_until) : 'Ingen',
        text: o.lock.behind ? `Lås ${fmtMonth(o.lock.month_end.slice(0, 7))} när den är fakturerad och lönen är körd.` : 'Förra månaden är låst.',
        link: '#/fakturering/lasning',
        label: 'Periodlåsning',
      }),
    );
  }
  if (o.payroll) {
    cards.push(
      card({
        title: `Löneunderlag, ${fmtMonth(o.payroll.month)}`,
        value: `${o.payroll.people} ${o.payroll.people === 1 ? 'person' : 'personer'}`,
        text: o.payroll.pending_people ? h('span', { class: 'chip warn' }, `${o.payroll.pending_people} med sådant som inte är attesterat`) : 'med avvikelser eller ersättningar',
        link: '#/fakturering/lon',
        label: 'Löneunderlag',
      }),
    );
  }
  if (o.warnings) {
    cards.push(
      card({
        title: 'Avtalsregistret',
        value: String(o.warnings.count),
        text: o.warnings.first.map((t) => h('div', { class: 'small' }, t)),
        link: '#/admin/avtal',
        label: 'Avtal',
      }),
    );
  }
  if (o.next_holiday) {
    cards.push(card({ title: 'Nästa helgdag', value: o.next_holiday.name, text: `${fmtDate(o.next_holiday.date)} (v. ${o.next_holiday.week})` }));
  }

  add(
    root,
    h('h1', {}, `Hej ${state.user.name.split(' ')[0]}`),
    h('p', { class: 'muted' }, cards.some((c) => c.classList.contains('attention')) ? 'Det här behöver göras.' : 'Inget som brådskar just nu.'),
    h('div', { class: 'cards' }, cards),
  );
}
