'use strict';

// Where each country's opinion polls are on English Wikipedia (read by polls.js). A country is a list of sets, one
// per question, each naming the page and the headings its table sits under; polls.js reads whatever columns the
// table has. Page titles are Wikipedia's own "next election" redirects where there is one, so a new election's
// page is followed without a change here.
//
// A set is { id, group, label, kind?, unit?, page, under, … }:
//   group    the heading it's listed under in the view's question list
//   page     the page's title (a redirect such as "Next … election" follows the current one), or
//            { after, suffix }: the title another page resolved to, plus a suffix
//   under    the headings its table sits under, outermost first (text or pattern); not all the levels are needed
//   skip     tables whose headings below `under` match are left out
//   merge    every table under the headings is one series (a table per year or per month)
//   variant  every table under the headings is one choice of this name ("Province"), named by its heading;
//            `base` names the table directly under the headings. A table with a column of its own for the
//            choice (a riding, a hypothetical leader), or whose answers come in groups (each leader's Positive /
//            Negative), needs neither; `variantLabel` names that choice. `variantPath` names a table by every
//            heading below `under`, not only its own ("JD Vance · Approval").
//   matchups a pattern for groups whose rows are each a contest between some of their answers (Australia's
//            two-party-preferred vote: Labor v Coalition, Labor v One Nation)
//   kind     'parties' for voting intention; 'approval' for approve / disapprove (the view shows the net);
//            'breakdown' where the columns are groups of voters and the variant the answer, so no column leads
//            another; otherwise a question
//   unit     'seats' for seat counts (projections, and the Dutch polls); percent otherwise
//   names    full names for the answers, where the table's own links don't give good ones
//
// Wikipedia's tables change shape now and then; a set whose table can't be read keeps its last good copy, and one
// that never could is left out of the list. TODO.md (not tracked) lists the countries and tables not done yet.

const YEAR = /^(19|20)\d\d$/;

// Canada
const CA_FEDERAL = 'Opinion polling for the next Canadian federal election';   // a redirect to the current election's page
const PROVINCES = {
  ab: 'Alberta', bc: 'British Columbia', mb: 'Manitoba', nb: 'New Brunswick', nl: 'Newfoundland and Labrador',
  ns: 'Nova Scotia', on: 'Ontario', pe: 'Prince Edward Island', qc: 'Quebec', sk: 'Saskatchewan',
};

// Germany
const DE = 'Opinion polling for the next German federal election';

// United Kingdom
const UK = 'Opinion polling for the next United Kingdom general election';
const UK_LEADERS = 'Leadership approval opinion polling for the next United Kingdom general election';
const UK_SCOTLAND = 'Opinion polling on Scottish independence';
const UK_EU = 'Opinion polling on the United Kingdom rejoining the European Union';

// United States
const US_2028 = 'Nationwide opinion polling for the 2028 United States presidential election';
const US_TRUMP = 'Opinion polling on the second Trump presidency';

// Elsewhere
const IE = 'Opinion polling for the next Irish general election';
const FR = 'Opinion polling for the next French presidential election';
const EU = 'Opinion polling for the next European Parliament election';
const AU = 'Opinion polling for the next Australian federal election';
const NZ = 'Opinion polling for the next New Zealand general election';
const PL = 'Opinion polling for the next Polish parliamentary election';
const NL = 'Opinion polling for the next Dutch general election';
const UA = 'Opinion polling for the next Ukrainian presidential election';
const JP = 'Opinion polling for the next Japanese general election';

const COUNTRIES = {
  ca: {
    name: 'Canada',
    sets: [
      { id: 'vote', group: 'Federal', label: 'Voting intention', kind: 'parties', page: CA_FEDERAL, under: ['National polls', 'Table of polls'],
        names: { LPC: 'Liberal', CPC: 'Conservative', BQ: 'Bloc Québécois', NDP: 'New Democratic', GPC: 'Green', PPC: "People's Party", Others: 'Other parties' } },
      { id: 'pm', group: 'Federal', label: 'Preferred prime minister', page: CA_FEDERAL, under: [/^Leadership polls/i], merge: true },
      { id: 'approval', group: 'Federal', label: 'Government approval', kind: 'approval', page: CA_FEDERAL, under: [/approval polls/i] },
      { id: 'regional', group: 'Federal', label: 'Voting intention by province', kind: 'parties', page: CA_FEDERAL, under: ['Regional polls'], variant: 'Province' },
      { id: 'ridings', group: 'Federal', label: 'Voting intention by riding', kind: 'parties', page: { after: CA_FEDERAL, suffix: ' by constituency' }, under: [], variant: 'Riding' },
      { id: 'leader', group: 'Federal', label: 'Voting intention with another party leader', kind: 'parties', page: CA_FEDERAL, under: [/^Voting intention with/i] },
      ...Object.entries(PROVINCES).map(([code, name]) => (
        { id: `prov-${code}`, group: 'Provincial voting intention', label: name, kind: 'parties', page: `Next ${name} general election`, under: [/^Opinion poll/i] })),
      { id: 'qc-independence', group: 'Questions', label: 'Quebec independence', page: 'Quebec sovereignty movement', under: [/^Opinion poll/i],
        skip: /by party/i, variant: 'Voters', base: 'All voters' },
      { id: 'qc-independence-party', group: 'Questions', label: 'Quebec independence, by party supported', kind: 'breakdown', page: 'Quebec sovereignty movement', under: [/^Opinion poll/i, /by party/i] },
      { id: 'ab-referendum', group: 'Questions', label: 'Alberta: the 2026 referendum question', page: 'Alberta separatist movement', under: [/referendum question/i] },
      { id: 'ab-separation', group: 'Questions', label: 'Alberta: separating from Canada', page: 'Alberta separatist movement', under: [/hypothetical separation/i] },
      { id: 'us-join', group: 'Questions', label: 'Joining the United States (asked of Canadians)', page: 'Movements for the United States annexation of Canada', under: [/^Canadian polling/i] },
      { id: 'us-join-us', group: 'Questions', label: 'Canada joining the United States (asked of Americans)', page: 'Movements for the United States annexation of Canada', under: [/^American polling/i], merge: true },
    ],
  },

  de: {
    name: 'Germany',
    sets: [
      { id: 'vote', group: 'Federal', label: 'Voting intention', kind: 'parties', page: DE, under: ['Poll results', YEAR], merge: true },
      { id: 'cdu-csu', group: 'Federal', label: 'Voting intention, CDU and CSU apart', kind: 'parties', page: DE, under: ['Poll results', 'CDU and CSU'] },
      { id: 'east-west', group: 'Federal', label: 'Voting intention, West and East', kind: 'parties', page: DE, under: [/^By Western and Eastern/i], variant: 'Region' },
      { id: 'states', group: 'Federal', label: 'Federal voting intention by state', kind: 'parties', page: DE, under: ['By state'], variant: 'State' },
      { id: 'scenarios', group: 'Federal', label: 'Voting intention in other scenarios', kind: 'parties', page: DE, under: [/^Scenario polls/i], variant: 'Scenario' },
      { id: 'chancellor', group: 'Leaders', label: 'Preferred chancellor', page: DE, under: ['Chancellor polling'], variant: 'Matchup' },
      { id: 'coalition', group: 'Leaders', label: 'Preferred coalition', page: DE, under: ['Preferred coalition'] },
    ],
  },

  gb: {
    name: 'United Kingdom',
    sets: [
      { id: 'vote', group: 'Westminster', label: 'Voting intention', kind: 'parties', page: UK, under: ['National poll results', YEAR], merge: true },
      { id: 'regional', group: 'Westminster', label: 'Voting intention by nation and region', kind: 'parties', page: UK, under: ['Sub-national poll results'], variant: 'Area' },
      { id: 'leaders', group: 'Leaders', label: 'Leader approval', kind: 'approval', page: UK_LEADERS, under: ['Leadership approval', YEAR], merge: true, variantLabel: 'Leader' },
      { id: 'party-approval', group: 'Leaders', label: 'Party approval', kind: 'approval', page: UK_LEADERS, under: ['Party approval', YEAR], merge: true, variantLabel: 'Party' },
      { id: 'other-politicians', group: 'Leaders', label: 'Approval of other politicians', kind: 'approval', page: UK_LEADERS, under: [/^Approval of other politicians/i], variant: 'Politician' },
      { id: 'possible-leaders', group: 'Leaders', label: 'Approval of possible party leaders', kind: 'approval', page: UK_LEADERS, under: ['Hypothetical leaders'], merge: true, variantLabel: 'Politician' },
      { id: 'scotland', group: 'Questions', label: 'Scottish independence', page: UK_SCOTLAND, under: [/2014 referendum question/i] },
      { id: 'scotland-leave', group: 'Questions', label: 'Scottish independence (Remain / Leave question)', page: UK_SCOTLAND, under: [/Remain \/ Leave/i] },
      { id: 'scotland-timing', group: 'Questions', label: 'Timing of a second Scottish referendum', page: UK_SCOTLAND, under: [/Timing of a second referendum/i] },
      { id: 'eu', group: 'Questions', label: 'Rejoining the European Union', page: UK_EU, under: ['Opinion polling', 'National polls', YEAR], merge: true },
      { id: 'eu-euro', group: 'Questions', label: 'Rejoining the EU if it meant adopting the euro', page: UK_EU, under: [/Conditioning Accession on Euro/i] },
      { id: 'eu-relationship', group: 'Questions', label: 'Relationship with the EU', page: UK_EU, under: [/^Change of relationship/i] },
    ],
  },

  ie: {
    name: 'Ireland',
    sets: [
      { id: 'vote', group: 'Dáil', label: 'Voting intention', kind: 'parties', page: IE, under: ['Opinion polls', 'Polls'] },
    ],
  },

  fr: {
    name: 'France',
    sets: [
      { id: 'first-round', group: 'Presidential election', label: 'First round', kind: 'parties', page: FR, under: ['First round'], merge: true },
      { id: 'second-round', group: 'Presidential election', label: 'Second round', page: FR, under: ['Second round'], variant: 'Matchup' },
      { id: 'rerun-2022', group: 'Presidential election', label: 'Re-run of the 2022 second round', page: FR, under: [/Re-run of the 2022/i, 'Second round'] },
    ],
  },

  eu: {
    name: 'European Union',
    sets: [
      { id: 'vote', group: 'European Parliament (projections)', label: 'Vote share by group', kind: 'parties', page: EU, under: [/^Popular vote projections/i] },
      { id: 'seats', group: 'European Parliament (projections)', label: 'Seats by group', kind: 'parties', unit: 'seats', page: EU, under: [/^Seat projections/i] },
    ],
  },

  us: {
    name: 'United States',
    sets: [
      { id: 'approval', group: 'President', label: 'Trump job approval', kind: 'approval', page: US_TRUMP, under: ['Nationwide job approval ratings', YEAR], merge: true },
      { id: 'approval-averages', group: 'President', label: 'Trump job approval, polling averages', kind: 'approval', page: US_TRUMP, under: [/^Aggregate polls$/i, 'Approval'] },
      { id: 'approval-states', group: 'President', label: 'Trump job approval by state', kind: 'approval', page: US_TRUMP, under: ['Statewide job approval ratings'], variant: 'State' },
      { id: 'approval-race', group: 'President', label: 'Trump job approval by race', kind: 'approval', page: US_TRUMP, under: [/job approval by race/i], variant: 'Voters' },
      { id: 'policies', group: 'President', label: 'Support for Trump policies', page: US_TRUMP, under: ['Policy-specific support'], variant: 'Policy' },
      { id: 'cabinet', group: 'President', label: 'Approval of cabinet officials', kind: 'approval', page: US_TRUMP, under: [/^Support for Trump cabinet/i], variant: 'Official', variantPath: true },
      { id: '2028', group: '2028 presidential election', label: 'National head-to-heads', page: US_2028, under: ['General election', 'Nationwide'], variant: 'Matchup' },
      { id: '2028-states', group: '2028 presidential election', label: 'Head-to-heads by state', page: US_2028, under: ['General election', 'Statewide'], variant: 'Matchup' },
    ],
  },

  au: {
    name: 'Australia',
    sets: [
      { id: 'vote', group: 'Federal', label: 'Voting intention', kind: 'parties', page: AU, under: ['Voting intention', YEAR], merge: true, matchups: /2PP|two-party/i, variantLabel: 'Count' },
      { id: 'electorates', group: 'Federal', label: 'Voting intention by electorate', kind: 'parties', page: AU, under: ['Individual electorate polling'], variant: 'Electorate' },
      { id: 'direction', group: 'Questions', label: 'Country heading in the right direction', page: AU, under: ['National direction polling'] },
    ],
  },

  nz: {
    name: 'New Zealand',
    sets: [
      { id: 'vote', group: 'General election', label: 'Party vote', kind: 'parties', page: NZ, under: ['Party vote'] },
      { id: 'electorates', group: 'General election', label: 'Electorate vote', kind: 'parties', page: NZ, under: ['Electorate polling'], variant: 'Electorate' },
      { id: 'demographic', group: 'General election', label: 'Party vote by group', kind: 'parties', page: NZ, under: ['Demographic polling'], variant: 'Voters' },
      { id: 'pm', group: 'Leaders', label: 'Preferred prime minister', page: NZ, under: ['Preferred prime minister'] },
      { id: 'leader-approval', group: 'Leaders', label: 'Leader approval', kind: 'approval', page: NZ, under: ['Leadership approval rating'], variantLabel: 'Leader' },
      { id: 'government', group: 'Leaders', label: 'Government direction', page: NZ, under: ['Government approval rating'] },
    ],
  },

  pl: {
    name: 'Poland',
    sets: [
      { id: 'vote', group: 'Sejm', label: 'Voting intention', kind: 'parties', page: PL, under: ['Poll results', YEAR], merge: true },
      { id: 'scenarios', group: 'Sejm', label: 'Voting intention in other scenarios', kind: 'parties', page: PL, under: ['Poll results', 'Alternative scenarios'] },
      { id: 'cities', group: 'Sejm', label: 'Voting intention by city', kind: 'parties', page: PL, under: ['Local sample'], variant: 'City' },
      { id: 'candidates', group: 'Leaders', label: 'Prime ministerial candidates', page: PL, under: ['Leadership polling'], variant: 'Question' },
    ],
  },

  nl: {
    name: 'Netherlands',
    sets: [
      { id: 'seats', group: 'House of Representatives', label: 'Seats', kind: 'parties', unit: 'seats', page: NL, under: ['Opinion polls', 'Seats'] },
      { id: 'vote', group: 'House of Representatives', label: 'Vote share', kind: 'parties', page: NL, under: ['Opinion polls', 'Vote share'] },
    ],
  },

  ua: {
    name: 'Ukraine',
    sets: [
      { id: 'first-round', group: 'Presidential election', label: 'First round', page: UA, under: ['First round'], merge: true },
      { id: 'second-round', group: 'Presidential election', label: 'Second round', page: UA, under: ['Second round'], variant: 'Matchup' },
      { id: 'second-round-pre2022', group: 'Presidential election', label: 'Second round, before the 2022 invasion', page: UA, under: [/^Pre-2022 invasion/i], variant: 'Matchup' },
    ],
  },

  jp: {
    name: 'Japan',
    sets: [
      { id: 'vote', group: 'House of Representatives', label: 'Voting intention (proportional vote)', kind: 'parties', page: JP, under: [/^Voting intention/i, YEAR], merge: true },
      { id: 'party-id', group: 'House of Representatives', label: 'Party support', kind: 'parties', page: JP, under: ['Party identification', YEAR], merge: true },
      { id: 'cabinet', group: 'Leaders', label: 'Cabinet approval', kind: 'approval', page: JP, under: [/^Cabinet approval/i], merge: true },
      { id: 'pm', group: 'Leaders', label: 'Preferred prime minister', page: JP, under: ['Preferred prime minister', YEAR], merge: true },
      { id: 'coalition', group: 'Leaders', label: 'Preferred coalition', page: JP, under: ['Preferred coalition', YEAR], merge: true },
    ],
  },
};

module.exports = { COUNTRIES };
