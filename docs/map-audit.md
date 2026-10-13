# Map audit: wrong place mappings and the matching engine

October 2026. Checked against the live database (14,651 stored items, 12,837 distinct articles).

## Summary

The map placed many stories in the wrong place. Some errors were outright wrong locations (every
Australia story sat on the Ashmore and Cartier Islands in the Timor Sea; "Philadelphia police" went
to Amman; "Vladimir Putin" went to the Russian city of Vladimir; "Hunger in the South" went to South
Africa). The rest was noise: each article dropped a marker on every country it mentioned, including
nationalities ("Israeli", "Houthi") and passing mentions, so big markers grew on the United States,
Israel and Russia whatever the story was about.

The matcher was rebuilt (details below). On 293 hand-checked articles:

| | Before | After |
|---|---|---|
| Articles with at least one wrong place: audit set (213, mostly picked for errors) | 124 (58%) | 5 (2.3%) |
| Articles with at least one wrong place: random held-out sample (80) | 15 (19%) | 2 (2.5%) |
| Precision (places shown that are right), held-out | 80.6% | 97.4% |
| Recall (places that should be shown and are), held-out | 91.7% | 95.8% |

Across the whole database: 5,992 of 12,837 distinct articles change. Place markers per article drop by
43% (26,495 -> 15,217) while slightly *more* articles get a place (11,714 -> 11,922). Stored items are
re-tagged automatically the first time the new version starts.

The labelled articles are in `tests/unit/geotag-corpus.json` and run as a unit test
(`tests/unit/geotag-corpus.test.js`), so a regression shows up in `npm run test:unit`.

**Full list:** every changed article, with its old and new places and the cause of each removed
place, is in [`map-audit-changes.csv`](map-audit-changes.csv) (5,992 rows). Its "new" column is the
new matcher's output, not hand-checked; the hand-checked articles are the tables at the end.

## Causes

Counts are distinct articles with at least one place removed for that cause (an article can have several).

| Cause | Articles | What happened | Example |
|---|---|---|---|
| Country data | 66 | Natural Earth gives the Ashmore and Cartier Islands Australia's code as a fallback; it overwrote Australia, so the country "Australia" was named and placed after the islands. | "Australia has never driven migration into reverse" -> Ashmore and Cartier Islands |
| Name lists | 466 | Demonyms were split on spaces, so "South African" added **South** and **African** as names of South Africa, "Sri Lankan" added **Sri**. "Seoul's", "Tehran's", "Pyongyang" were listed as words for the *country*, so Seoul stories went to the middle of South Korea. | "The South battlegroup… Kramatorsk" -> South Africa |
| Foreign-language alternate names | 100 | Cities over 1M took every GeoNames alternate name: Arabic, Chinese, Russian transliterations. Many are English words or names: Sam (Damascus), Bin (Vienna), Part and Pet (Perth), Dual (Douala), Lim (Lima), Cheng (Zhengzhou). Some even beat the real city: Philadelphia (Amman's ancient name), Bethlehem (Belém), Visakhapatnam (another town). | "Man with gun kills one Philadelphia police officer" -> Amman |
| Everyday words, brands, acronyms | 48 | Towns from the conflict-zone lists (all towns ≥15k) and big cities whose names are words: Male, Marks, Perm (US PERM visas), Brent (crude), Toyota, Sabha (Lok/Rajya Sabha), Duma, Mataram (Vande Mataram). | "Male infertility is grossly underreported" -> Malé, Maldives |
| People and companies | 165 | First names and surnames: Vladimir (Putin, Zelensky), Kennedy, Anna, Stanley (Morgan Stanley), Lyon (Nathan Lyon), Leon, Austin, Columbus, Jordan. | "Conor Kennedy and Giulia Be Married in Rio" -> Kennedy, Colombia |
| Nationality / actor words | 2,711 | "Russian", "Israeli", "Houthi", "Putin", "Kremlin" put a marker on the country even when the story was elsewhere. | "Indian national dies after Riyadh airport attack" -> India + Riyadh |
| Passing mentions | 2,588 | All places in the title *and* the first 300 characters of the summary counted equally, including datelines ("NAIROBI (Reuters) -") and GDELT's list of every place in the article body. | "Boat from Djibouti to Yemen capsizes" -> + Nairobi (the wire's dateline) |
| Redundant countries | 1,180 | A country was shown next to a city in it ("Riyadh" + "Saudi Arabia"), so the same story appeared twice, 900 km apart. Not wrong, but it doubled the clutter. | |

The last three are why the markers kept growing as sources were added: an article about Gaza
typically carried Israel, Palestine and Gaza; one about a Houthi strike carried Yemen, Saudi Arabia
and Riyadh.

## The matching engine

### How it worked

`geotag(text)` took the title plus 300 characters of the summary as one string, found capitalised
1–4 word phrases in the gazetteer (longest first), and resolved a name with several candidates by
kind (country > region > state > capital > city), then population, nudged by countries that were
named unambiguously elsewhere in the text. It returned the first five places in order of mention.

Problems, beyond the data errors above:

1. **Every mention was a location.** No difference between "in Riyadh", "Indian national",
   "Washington says" and a dateline.
2. **Title and summary weighed the same**, so a passing mention in the summary was as strong as the
   headline's subject.
3. **No defence against names.** Capitalised words next to other capitalised words (Vladimir Putin,
   Morgan Stanley, New York Times) matched like any place.
4. **Kind outranked everything.** Any capital beat any city (Amman beat Philadelphia), any country
   beat any state (Georgia was always the country without other US places nearby).
5. **Hyphenated words were never split**: "US-Iran talks", "Al-Mukalla", "Saudi-led" found nothing.
6. **GDELT's own geocoding was thrown away**: its summary "Locations: Riyadh, Ar Riyad, Saudi
   Arabia; …" was rescanned as free text ("Tehran, Tehran, Iran" -> Iran twice).
7. **The source didn't count.** "Hyderabad" in Dawn (Pakistan) and in The Hindu (India) resolved the
   same way.

### What changed

**Gazetteer (`scripts/build-geo.js`)**

- Natural Earth countries: a feature with its own ISO code always wins over a dependency carrying it
  as a fallback (Australia was the only country this broke).
- No GeoNames alternate names. Official and ASCII names only, plus a curated list of news spellings
  (Kyiv/Kiev, Odesa, Sloviansk, Bombay, Riyad, Peking, Saigon…). The index went from 16,699 names to
  5,859, and from 593 KB to 370 KB.
- Demonyms and other actor words (Israeli, Houthi, Putin, Kremlin) are a separate list. They point
  at a country but don't place a story. "UK", "US", "America", "Britain" stay names of the country.
- Three word lists: never matched (Male, Brent, Toyota…), *weak* (also first names or surnames:
  Vladimir, Austin, Jordan…), and the rest.
- A city sharing its name with one 10× larger is dropped from that name (a 47k Russian town called
  Donetsk). City districts (Shinjuku, Obolon) point at their city; a district name several cities
  have is dropped.
- Landmarks name their city's country (Downing Street was London, *Ontario*).
- Indian states and Chinese provinces added (Kerala, Telangana, Tibet…); multinational seas and
  regions (Red Sea, Middle East, Strait of Hormuz) no longer belong to one country.

**Matcher (`src/main/enrich/geotag.js`)**

1. **Mentions**: hyphens split (US-Iran, Al-Mukalla); a phrase never crosses punctuation;
   "Times of India", "Jerusalem Post", "Sapporo breweries" are skipped.
2. **Weak names** are dropped next to another capitalised non-place word (Vladimir Putin, Morgan
   Stanley), and otherwise need evidence: a preposition ("in Austin"), "Douglas, Georgia", another
   place in the same country, or the source's own country. In Headline Case titles, where any word
   may be capitalised, only the first two count.
3. **Ambiguity** is scored: kind and population, +4 for another place in the same country, +1 for an
   actor word for it, +2 for the source's home country (from its sidebar group). A US state named
   like a country (Georgia) gets a small edge, which context overrides.
4. **Selection**: the title decides.
   - Places the title names are kept. The summary only adds places *inside* them (Russia -> Irkutsk,
     Scotland -> Glasgow), and never a capital ("Moscow said…" means the government).
   - With no place in the title, summary places inside the title's actor countries come first
     ("Ukrainian drones target Russian tech giant" + "a data center in Vladimir" -> Vladimir), then the
     summary's places in the country it mentions most (an "in"/"at" counts double), then the actor
     countries, then the dateline.
   - A country is dropped when a place inside it is kept. At most three places.
5. **GDELT** location lists are read as data: "City, Province, Country" resolves the city within that
   country.
6. **Re-tagging**: `GEOTAG_VERSION` is stored in the database; when it changes the feed worker
   re-tags every stored item in chunks of 500 and pushes the new places for recent ones to the UI.

The GDELT adapter now also orders an article's locations by where they first appear in it, so
the six it keeps are the most prominent.

### Known limitations

- **Metonyms.** "Washington says", "Tehran rejects" still map to the capital when they're the only
  place in the title. Capitals in summaries are skipped, which occasionally loses a real one
  ("protesters walking through Cairo" in an article about Egypt shows Egypt).
- **Weak names lose some true hits.** "Victoria sold heritage hospital land…" in an Indian paper
  shows nothing, because nothing else says Australia.
- **Gazetteer coverage.** Cities under 300k outside the conflict-zone list are missing (Kohat,
  Southampton, Lens). Adding them would mean more name collisions; the curated alias list is the
  safer place to add any that matter.
- **Actor countries and passing mentions** are a judgement call: "Spain rejects claims Russian
  freighter carried parts to North Korea" shows Spain and North Korea. The held-out sample still has
  two wrong mappings, both summaries mentioning an unrelated place ("Also in Kenya…" in a TV
  programme summary).

## Verified wrong mappings

Every hand-checked article the old matcher got wrong (139), with the wrongly mapped place, the text
that triggered it, the correct location, and what the map shows now. Grouped by the cause of the
first wrong place.

### Country data: Australia placed on the Ashmore and Cartier Islands (9)

| # | Source | Article | Wrongly mapped to <- matched text | Correct location | Now |
|---|---|---|---|---|---|
| 14376 | BBC | Sensational Smith, relentless quicks - Australia veterans serve reminder | **Ashmore and Cartier Islands** <- "Australia" | no single place (acceptable: Australia, South Africa) | Australia |
| 14013 | Guardian | The Australian’s Shadow of Doubt podcast delayed ‘sadistic’ paedophile’s trial, court documents reveal | **Ashmore and Cartier Islands** <- "Australian" | Australia | Australia |
| 14014 | Guardian | Australia has never driven migration into reverse by design. Would slamming the brakes on be calamitous? | **Ashmore and Cartier Islands** <- "Australia" | Australia | Australia |
| 13139 | Times of India | Matt Renshaw breaks Virat Kohli’s decade-old record with stunning 190 in Durban | **Ashmore and Cartier Islands** <- "Australia"; **Lyon** <- "Lyon" | Durban | Durban |
| 12044 | ABC Australia | Quick hits: AFL star in the sheds as Aussies go better than Bradman | **Lyon** <- "Lyon"; **Ashmore and Cartier Islands** <- "Australia" | no single place (acceptable: Australia, South Africa, Gold Coast) | Gold Coast |
| 12347 | GDELT Middle East | UAE CONFIRMS: Flydubai Co-Pilot Planned To Crash Plane At Ben Gurion | **Melbourne** <- "Melbourne"; **Victoria** <- "Victoria"; **Ashmore and Cartier Islands** <- "Australia"; **Jerusalem** <- "Jerusalem" | Tel Aviv | United Arab Emirates, Tel Aviv |
| 10072 | GDELT Middle East | FlyDubai co-pilot intended to crash plane into Tel Aviv airport, UAE prosecutor says | **Ashmore and Cartier Islands** <- "Australia"; **Tabuk** <- "Tabuk"; **Saudi Arabia** <- "Saudi Arabia" | Tel Aviv | Tel Aviv, United Arab Emirates |
| 9222 | Japan Today | Judge convicts 3 Mexicans in killings of 2 Australian brothers and American friend on surf trip | **Ashmore and Cartier Islands** <- "Australian" | Mexico | Mexico |
| 12821 | Guardian | Ben Roberts-Smith attends Canberra event honouring Australian troops who served in Afghanistan | **Ashmore and Cartier Islands** <- "Australian" | Canberra | Canberra, Afghanistan |

### Name lists: "South", "African", "Sri" and capitals mapped to the wrong place (10)

| # | Source | Article | Wrongly mapped to <- matched text | Correct location | Now |
|---|---|---|---|---|---|
| 14030 | RÚV | Hunger in the South due to the planned income tax | **South Africa** <- "South" | no single place (acceptable: Iceland) | — |
| 13574 | Intel Slava | 🇷🇺🇺🇦⚡ The South battlegroup has destroyed three shelters with Ukrainian infantry in the Kramatorsk distric… | **South Africa** <- "South" | Kramatorsk | Kramatorsk |
| 13307 | Korea Herald | Seoul raises travel alert, urges citizens to leave Saudi Arabia | **South Africa** <- "South" | Saudi Arabia | Seoul, Saudi Arabia |
| 13695 | Daily News Egypt | AAIB obtains updated PCI DSS v4.0.1 cybersecurity certification | **South Africa** <- "African" | no single place (acceptable: Egypt) | — |
| 14228 | The Hindu | Over 90,000 devotees attend first day of Sarannavaratri festivities atop Indrakeeladri | **Sri Lanka** <- "Sri" | Andhra Pradesh | Andhra Pradesh |
| 7917 | The Namibian | Sam Nujoma Stadium upgrade faces rethink | **Damascus** <- "Sam"; **South Africa** <- "African" | Windhoek | Windhoek |
| 6849 | ERR News | Forgotten trail camera yields nine months of wildlife images | **South Africa** <- "South" | Estonia | Estonia |
| 13359 | Iceland Review | Yellow Weather Warning as Gales Approach South Iceland Tonight | **South Africa** <- "South" | Iceland | Iceland |
| 2161 | NK News | ‘Unidentified explosion’ near North Korean border injures 3 South Korean troops | **South Africa** <- "South" | South Korea | Seoul |
| 3918 | Times of India | John Paul DeJoria turned 96-acre Texas ranch into home for 120 exotic animals | **South Africa** <- "African" | Texas | Texas |

### Foreign-language alternate names (Sam = Damascus, Philadelphia = Amman) (24)

| # | Source | Article | Wrongly mapped to <- matched text | Correct location | Now |
|---|---|---|---|---|---|
| 13856 | Intel Slava | 🇺🇦⚡ Part of the Obolonskyi, Podilskyi, Shevchenkivskyi and Desnianskyi districts of Kiev is left without ele… | **Perth** <- "Part"; **Podilskyi** <- "Podilskyi"; **Shevchenkivskyi** <- "Shevchenkivskyi" | Kyiv | Kropyvnytskyi, Kyiv |
| 13751 | Guardian | Campaign launched to safeguard site of first home of Scotland’s national football team | **Perth** <- "Part" | Glasgow | Scotland, Glasgow |
| 9733 | The Namibian | Wealth Tip: Why a Good Money Mindset Matters | **Perth** <- "Part" | no single place (acceptable: Namibia) | — |
| 861 | Moscow Times | Russia Investigates Contaminated Dog Vaccine Linked to Mass Pet Deaths | **Perth** <- "Pet" | Russia | Russia |
| 308 | EU Parliament | Article - Vote for Turtle: a fun game for spotting disinformation | **Perth** <- "Pet" | no single place | — |
| 8454 | NBC News | Remembering Mike Ditka's life and legacy | **Damascus** <- "Sam" | no single place (acceptable: Chicago) | Chicago |
| 3506 | Guardian | Bachelor star Sam Wood denied bail as police allege he choked wife until she ‘thought she would die’ | **Damascus** <- "Sam" | Queensland | Queensland |
| 10053 | SCMP News | Can China’s dancing robots swing some new business partners in Africa? | **Vienna** <- "Bin" | Luanda | China |
| 6698 | Mexico News Daily | Puerto Vallarta, San Miguel de Allende rank among world’s 5 best small cities in Condé Nast Traveler readers’… | **San Diego** <- "San Miguel" | no single place (acceptable: Mexico) | Mexico |
| 62 | NYT | Leon Botstein, Former Bard President With Epstein Ties, Resigns From College Positions | **Leon de los Aldama** <- "Leon" | no single place (acceptable: United States, New York) | — |
| 400 | Guardian | Leon Botstein resigns from Bard roles as key Democrat demands investigation into Epstein links | **Leon de los Aldama** <- "Leon" | no single place (acceptable: United States, New York) | — |
| 6583 | SCMP Hong Kong | Hong Kong police to launch international academy, reveal details of new degree | **Zhengzhou** <- "Cheng" | Hong Kong | Hong Kong |
| 1674 | SCMP Hong Kong | Adrian Cheng, former scion of Hong Kong’s NWD, expands K11 brand in Xiamen | **Zhengzhou** <- "Cheng" | Xiamen | Hong Kong, Xiamen |
| 9289 | Japan Times | Beer maker leaders may have been aware of price cartel | **Jilin** <- "Kirin"; **Sapporo** <- "Sapporo" | no single place (acceptable: Japan) | — |
| 3503 | Guardian | Japan beer giants raided over suspicions they colluded to set the price of beverages | **Jilin** <- "Kirin"; **Sapporo** <- "Sapporo" | Japan | Japan |
| 3815 | Anadolu | Airstrikes reported on Houthi sites as 3 explosions rock Yemen's Al-Mukalla | **Lima** <- "Rima" | Mukalla | Mukalla, Hodeidah |
| 478 | RFI English | French MEP Hassan under investigation over flag incident at 7 October commemoration | **Lima** <- "Rima"; **Palestine** <- "Hamas"; **Gaza Strip** <- "Gaza" | no single place (acceptable: France, Israel) | Gaza Strip |
| 4181 | Korea Herald | Yoo Seung-ho, Lim Se-joo admit past romance, deny reports of current relationship | **Lima** <- "Lim" | no single place (acceptable: South Korea) | — |
| 1598 | SCMP Asia | Singaporean massage parlour boss added to US ‘worst of the worst criminal aliens list’ | **Lima** <- "Lim" | no single place (acceptable: Singapore, United States) | United States |
| 6880 | Bangkok Post | City Hall to clean up Rom Klao estate 'in 4-5 days' | **Rome** <- "Rom" | Bangkok | Bangkok |
| 11131 | GDELT Middle East | Trump's bizarre invite is enough to put him in prison for life | **Rome** <- "Loma"; **Iran** <- "Iranian" | no single place (acceptable: United States, California, Nebraska) | California, Nebraska |
| 10271 | Times of India | 'Only openers' spots are permanent': Gambhir's clear message on India's batting order | **Dubai** <- "Dube" | no single place (acceptable: India, Ranchi) | Ranchi |
| 9581 | The Hindu | Telangana CM Revanth calls for PRT system to improve public transport in Hyderabad | **Perth** <- "PRT" | Hyderabad (India) | Telangana, Hyderabad |
| 6214 | Jerusalem Post | IDF kills Hamas commander who held several former Israeli hostages in Gaza City strikes | **Palestine** <- "Hamas"; **Rome** <- "Romi" | Gaza City | Gaza City |

### Everyday words, brands and acronyms (26)

| # | Source | Article | Wrongly mapped to <- matched text | Correct location | Now |
|---|---|---|---|---|---|
| 10735 | Global News | Dual elections a headache for some B.C. voters | **Douala** <- "Dual" | British Columbia | British Columbia |
| 9280 | Al Jazeera | Dual quakes devastate southern Panama | **Douala** <- "Dual" | Panama | Panama |
| 600 | DW | Dual citizenship means Germany now in competition for talent | **Douala** <- "Dual" | Germany | Germany |
| 9743 | GDELT Middle East | Gaza Ceasefire Anniversary Marks Year of Broken Promises | **Marks** <- "Marks" | Gaza Strip | Gaza Strip |
| 9655 | GDELT Middle East | Gaza: Ceasefire Anniversary Marks Year of Failed Promises | **Marks** <- "Marks"; **Beirut** <- "Beirut" | Gaza Strip | Gaza Strip |
| 3035 | GDELT Middle East | News 12 | Westchester | Tarrytown Temple Marks 3 Years Since Oct 7 Attacks In Israel | **Marks** <- "Marks" | no single place (acceptable: Israel, United States) | Israel |
| 7327 | The Namibian | First Gentleman Ndaitwah Calls for Coordinated National Action to Empower Boys and Men | **Male** <- "Male" | Windhoek | Windhoek |
| 590 | DW | Male infertility is 'grossly underreported' | **Male** <- "Male" | no single place | — |
| 9459 | CGTN | Botswana's president to pay state visit to China Oct. 12 to 17 | **Duma** <- "Duma" | China | Botswana, China |
| 844 | TASS | NATO’s eastern flank plan is preparation for aggression against Russia, says Duma member | **Duma** <- "Duma"; **Ukraine** <- "Ukrainian" | no single place (acceptable: Russia) | Russia |
| 11343 | Arab News | Al-Ameri wins pro category as Saudi Toyota Drift Championship opens in Al-Ahsa | **Toyota** <- "Toyota" | no single place (acceptable: Saudi Arabia) | Saudi Arabia |
| 2053 | Thailand Business News | Thailand’s Floods Expose Severe Vulnerabilities in Its Automotive Supply Chain | **Toyota** <- "Toyota" | Thailand | Thailand |
| 13840 | The Hindu | Vande Mataram presented at Dasara inauguration in Shivamogga violating State govt. order, Congress leaders wal… | **Mataram** <- "Mataram" | Shivamogga | Shivamogga |
| 6464 | The Hindu | Vande Mataram row: Clash erupts at Central University of Kerala during SFI-led protest; police use water canno… | **Mataram** <- "Mataram" | Kerala | Kerala |
| 5332 | The Hindu | Central University of Kerala suspends five students over protests at ande Mataram seminar | **Mataram** <- "Mataram" | Kerala | Kerala |
| 13764 | The Hindu | Work for NDA victory in local body elections for the good of tribes, exhorts Pawan Kalyan | **Kalyan** <- "Kalyan" | no single place (acceptable: Andhra Pradesh, India) | — |
| 13168 | The Hindu | Road connectivity, not a mere concrete path, but a road to development for tribes, says Pawan Kalyan | **Kalyan** <- "Kalyan" | Andhra Pradesh | Andhra Pradesh |
| 14527 | The Hindu | The federal dilemma of delimitation | **Sabha** <- "Sabha" | no single place (acceptable: India) | — |
| 14158 | The Hindu | From raising students’ concerns, CJP has suddenly shifted to electoral issues: BJP | **Sabha** <- "Sabha" | no single place (acceptable: India) | — |
| 13164 | The Hindu | Keralam Rajya Sabha MP John Brittas allegedly assaulted by CRPF personnel; SFI activists suffer injuries | **Sabha** <- "Sabha" | no single place (acceptable: Kerala, India) | — |
| 7351 | GDELT Middle East | Sources suggest that US-Iran exchanges continued since they met in New York; Brent lower as Trump suggests he… | **Brent** <- "Brent"; **France** <- "France" | no single place (acceptable: United States, Iran, New York) | Iran, New York |
| 4736 | Anadolu | Global markets turn negative as Fed minutes fuel rate hike expectations | **Brent** <- "Brent" | no single place (acceptable: Washington DC, Iran, United States) | Washington DC, Iran |
| 3731 | TASS | Brent crude tops $104 per barrel on ICE for first time since September 29 | **Brent** <- "Brent" | no single place | — |
| 11698 | Reuters (Bluesky) | India's Infosys does not expect material impact from US PERM suspension reut.rs/4eq0yuZ | **Perm** <- "PERM" | no single place (acceptable: India, United States) | India, United States |
| 12170 | Reuters / AP (Google News) | India's Infosys does not expect material impact from US PERM suspension | **Perm** <- "PERM" | no single place (acceptable: India, United States) | India, United States |
| 10761 | The Hindu | If India plays its cards right, suspension of PERM may be an opportunity: Priyank Kharge | **Perm** <- "PERM" | no single place (acceptable: India, Karnataka) | Karnataka |

### People and companies named like places (21)

| # | Source | Article | Wrongly mapped to <- matched text | Correct location | Now |
|---|---|---|---|---|---|
| 14373 | Guardian | Trump’s deal with Putin will have little impact on US diesel prices, experts warn | **Vladimir** <- "Vladimir" | United States | United States |
| 13649 | TASS | Ballistic missiles, not Trump's words, bringing about victory in special op — Medvedev | **Vladimir** <- "Vladimir" | no single place (acceptable: Russia, Ukraine, United States) | Ukraine |
| 12326 | NYT Politics | Conor Kennedy and Giulia Be Married in Rio | **Kennedy** <- "Kennedy" | Rio de Janeiro | Rio de Janeiro |
| 11765 | NPR | The Kennedy Center names new artistic director, amid concerns | **Kennedy** <- "Kennedy" | no single place (acceptable: Washington DC, United States) | — |
| 7449 | CBC | 8 people hospitalized after turbulence forces Medellin-New York flight to divert to Miami | **Kennedy** <- "Kennedy" | Miami | Medellin, New York, Miami |
| 12904 | Tagesschau | Huthi attack on Riyadh airport: Nightmare at the departure gate | **Iran** <- "Iran"; **United States** <- "US"; **Anna** <- "Anna" | Riyadh | Riyadh |
| 13357 | RÚV | Anger at the murder of a Japanese woman | **Anna** <- "Anna"; **United States** <- "American" | no single place (acceptable: Japan) | Japan |
| 11199 | RÚV | Sandra went to the Isle of Wight | **Anna** <- "Anna" | no single place (acceptable: Iceland) | — |
| 13074 | The National | UAE IPOs and credit markets primed for growth once war ends, Morgan Stanley executive says | **Stanley** <- "Stanley" | United Arab Emirates | United Arab Emirates |
| 7845 | SCMP Hong Kong | Developer of One Stanley pledges 6-year warranty and checks amid steel bar probe | **Stanley** <- "Stanley" | Hong Kong | Hong Kong |
| 1628 | SCMP Hong Kong | 24 luxury houses at One Stanley sold amid probe into alleged construction defects | **Stanley** <- "Stanley" | Hong Kong | Hong Kong |
| 8060 | NYT US | Ocasio-Cortez to Campaign for El-Sayed on Bus Tour in Michigan | **Alexandria** <- "Alexandria" | Michigan | Michigan |
| 12520 | Guardian | Five people shot and killed in apparent murder-suicide, Georgia police say | **Georgia** <- "Georgia"; **Douglas** <- "Douglas" | Georgia (US state) | Georgia |
| 12155 | NYT US | 5 Killed in Murder-Suicide at a Home in Georgia | **Georgia** <- "Georgia"; **Douglas** <- "Douglas" | Georgia (US state) | Georgia |
| 10150 | Reuters (Bluesky) | Five shot dead at residence in Georgia's Douglas, police says reut.rs/4yic3fl | **Georgia** <- "Georgia"; **Douglas** <- "Douglas" | Georgia (US state) | Georgia |
| 5755 | PBS | Botched execution reignites debate surrounding death penalty | **Austin** <- "Austin" | Tennessee | Tennessee |
| 10366 | RÚV | No straight lines in the last show of the show | **Victoria** <- "Victoria" | no single place (acceptable: Iceland) | — |
| 14310 | Trump-Truth Social | HAPPY COLUMBUS DAY TO ALL, in particular our great Italian American Community which was forced to suffer as th… | **Columbus** <- "COLUMBUS" | no single place (acceptable: United States, Italy) | Italy |
| 14047 | NYT | Samuel Alito and New Jersey’s Fallen Columbus Statue | **Columbus** <- "Columbus" | New Jersey | New Jersey |
| 8784 | NYT US | Trump Casts Himself as Columbus’s Protector in Pitch to Italian Americans | **Columbus** <- "Columbus" | no single place (acceptable: United States, Italy) | Italy, United States |
| 11330 | Ukrinform | Kallas: “This is not the time to ease pressure on Russia, and Europe won’t” | **Moscow** <- "Moscow"; **Vladimir** <- "Vladimir" | no single place (acceptable: Russia, Ukraine, United States) | Russia |

### Nationality and actor words treated as locations (11)

| # | Source | Article | Wrongly mapped to <- matched text | Correct location | Now |
|---|---|---|---|---|---|
| 14522 | RT | Ukrainian drones target Russian tech giant’s data centers | **Ukraine** <- "Ukrainian" | Vladimir | Vladimir |
| 12938 | Ukrinform | Russian airstrike hits apartment buildings in Sloviansk, injuring four | **Russia** <- "Russian" | Sloviansk | Sloviansk |
| 14555 | GDELT Middle East | Passenger terminal at Riyadh airport struck again | **Mecca** <- "Mecca"; **Bangladesh** <- "Bangladeshi"; **Iran** <- "Iran" | Riyadh | Riyadh |
| 3484 | BBC | Gazans face near-daily Israeli strikes a year into ceasefire | **Palestine** <- "Palestinians" | Gaza Strip | Gaza Strip |
| 11727 | GDELT Middle East | In First, Putin Conveys High Level Message To Trump On Ending Iran War | **Turkmenistan** <- "Turkmenistan"; **Israel** <- "Israeli" | no single place (acceptable: Russia, Iran, United States) | Iran |
| 10126 | GDELT Middle East | Riyadh airport resumes normal operations after Houthi attacks: Media | **Yemen** <- "Houthi"; **Khamis Mushait** <- "Khamis Mushait" | Riyadh | Riyadh |
| 9691 | Anadolu | Riyadh airport resumes normal operations after Houthi attacks: Media | **Yemen** <- "Houthi" | Riyadh | Riyadh |
| 4955 | Anadolu | Eckert free to stay as Southampton boss after suspended ban over Spygate scandal | **Germany** <- "German" | no single place (acceptable: United Kingdom, England) | — |
| 10335 | Ukrinform | Russian airstrike on Zaporizhzhia: Death toll rises to 12, including three children | **Russia** <- "Russian" | Zaporizhzhia | Zaporizhzhia |
| 11931 | GDELT Middle East | President Trump Weighs Joining US Saudi Strikes on Houthis After Riyadh Airport Attack | **Yemen** <- "Houthis" | Riyadh | United States, Riyadh |
| 3084 | GDELT Middle East | Saudi Arabia says 3 dead at airports after Houthis claim attacks | **Red Sea** <- "Red Sea"; **Djibouti** <- "Djibouti"; **Sudan** <- "Sudanese" | Saudi Arabia | Saudi Arabia |

### Places mentioned in passing, not where the story happens (38)

| # | Source | Article | Wrongly mapped to <- matched text | Correct location | Now |
|---|---|---|---|---|---|
| 12040 | Guardian | Man with gun kills one Philadelphia police officer and injures another | **Amman** <- "Philadelphia" | Philadelphia | Philadelphia |
| 11900 | Reuters / AP (Google News) | Philadelphia police officer killed, another injured after responding to reports of man with a gun | **Amman** <- "Philadelphia" | Philadelphia | Philadelphia |
| 11662 | NYT US | One Philadelphia Police Officer Killed, Another Shot 12 Times in Ambush Attack | **Amman** <- "Philadelphia" | Philadelphia | Philadelphia |
| 8363 | Arab News | Settlers attack wedding procession near Bethlehem | **Belem** <- "Bethlehem" | Bethlehem | Bethlehem |
| 11216 | Middle East Eye | Israeli settlers kidnap three Palestinian farmers west of Bethlehem | **Tulkarm** <- "Tulkarm" | Bethlehem | Bethlehem |
| 9663 | BBC | Time to rise? Ranking European football's sleeping giants | **Tijuana** <- "Zaragoza" | no single place | Zaragoza |
| 14295 | The Hindu | Comic Con concludes in Visakhapatnam with cosplayers, creators and live acts | **Rasapudipalem** <- "Visakhapatnam" | Visakhapatnam | Visakhapatnam |
| 13191 | The Hindu | DRI officials seize 5.832 kg of gold worth ₹8.98 crore near Visakhapatnam | **Rasapudipalem** <- "Visakhapatnam" | Visakhapatnam | Visakhapatnam |
| 11448 | The Hindu | Visakhapatnam’s air was ‘poor’ or worse on 41 of 60 winter days, pollution board data show | **Rasapudipalem** <- "Visakhapatnam" | Visakhapatnam | Visakhapatnam |
| 329 | BBC | Burnham to hold security talks with German chancellor in Berlin | **Russia** <- "Russia" | Berlin | Berlin |
| 9844 | Times of India | Emma Stone’s Austin Mansion: couple restore $23.5m estate; never move in | **New York** <- "New York" | Austin | Austin, New York |
| 13472 | Intel Slava | 🇷🇺🇺🇦⚡ The Ukrainian armed forces may use chemical weapons to create a “scorched earth” in territories of t… | **Kramatorsk** <- "Kramatorsk" | Donetsk | Donetsk, Russia |
| 14551 | GDELT Middle East | Ancient Zoroastrian funerary inscription discovered near Iran's Sasanian ceremonial capital | **Kerman** <- "Kerman" | Marvdasht | Marvdasht |
| 14254 | GDELT Middle East | Kenyan Presidential Aspirant Threatens to Deport Dangote Over Planned Refinery | **Lagos** <- "Lagos" | Kenya | Nairobi |
| 14246 | GDELT Middle East | Presidential Aspirant Patrick Osoi Questions Sifuna's Political Momentum | **Burkina Faso** <- "Burkina Faso" | Kenya | Nairobi |
| 5295 | GDELT Middle East | Bulgaria Ends Search For Missing Syrian Sailors After Drone-Struck Ship Sinks | **Moscow** <- "Moscow"; **Russia** <- "Russia" | Bulgaria | Bulgaria |
| 3780 | Jerusalem Post | Knesset displays stories of Oct. 7 victims at international parliamentary conference | **Iran** <- "Iran"; **Qatar** <- "Qatar" | Tanzania | Tanzania |
| 12138 | GDELT Middle East | Herzog Thanks FlyDubai Captain For Saving Passengers, Invites Him To Jerusalem | **Tabuk** <- "Tabuk"; **Saudi Arabia** <- "Saudi Arabia" | no single place (acceptable: Jerusalem, Israel, United Arab Emirates) | Jerusalem |
| 11412 | GDELT Middle East | New York Times report on AIPAC hides a central truth about Israel's unpopularity – Mondoweiss | **Missouri** <- "Missouri"; **New Jersey** <- "New Jersey" | no single place (acceptable: Israel, United States, New York) | Israel |
| 9658 | GDELT Middle East | Trump and Iran insist midterms aren't a factor in war decisions | **Saudi Arabia** <- "Saudi Arabia" | no single place (acceptable: Iran, United States, Tehran) | Iran |
| 8422 | GDELT Middle East | Arab News | Eight killed as Israeli airstrikes continue in Gaza | **Jerusalem** <- "Jerusalem" | Gaza Strip | Gaza Strip |
| 4565 | GDELT Middle East | Don't let hubris get in the way of ending the Iran war (Editorial) | **District of Columbia** <- "District Of Columbia" | no single place (acceptable: Iran, Tehran, Washington DC) | Iran |
| 7278 | Arab News | Saudi fashion designer Alia Al-Salmi brings Kingdom’s heritage to global stage | **Paris** <- "Paris"; **China** <- "China"; **Milan** <- "Milan" | no single place (acceptable: Saudi Arabia, Jeddah) | Jeddah |
| 14347 | Al-Monitor | At least 139 migrants dead, including some children, after boat from Djibouti to Yemen capsizes, UN agency say… | **Nairobi** <- "NAIROBI" | Djibouti | Djibouti, Yemen |
| 11318 | GDELT Middle East | In First, Putin Conveys High Level Message To Trump On Ending Iran War | **Pakistan** <- "Pakistan"; **Turkmenistan** <- "Turkmenistan" | no single place (acceptable: Russia, Iran, United States) | Iran |
| 13799 | GDELT Middle East | Mystery in Turkmenistan: How Russia's diesel maneuver averted US strikes on Iran | **Washington DC** <- "Washington" | no single place (acceptable: Turkmenistan, Russia, United States) | Turkmenistan, Russia, United States |
| 10817 | GDELT Middle East | Houthi missiles target Saudi capital | **Iran** <- "Iran"; **Red Sea** <- "Red Sea"; **Djibouti** <- "Djibouti" | Riyadh | Riyadh |
| 10673 | GDELT Middle East | Houthi missiles target Saudi capital | **United Arab Emirates** <- "United Arab Emirates"; **United Kingdom** <- "Britain"; **Red Sea** <- "Red Sea" | Riyadh | Riyadh |
| 10587 | GDELT Middle East | Houthi missiles target Saudi capital | **Egypt** <- "Egypt"; **Cairo** <- "Cairo"; **Red Sea** <- "Red Sea" | Riyadh | Riyadh |
| 12995 | Al Jazeera | US bombs cargo vessel in Gulf of Oman ‘trying to run Iran blockade’ | **Persian Gulf** <- "Gulf of Oman" | Gulf of Oman | United States, Gulf of Oman, Iran |
| 13471 | Intel Slava | 🇷🇺⚡ Trump's sharp statements about Zelensky will lead to nothing, Medvedev believes. | **Washington DC** <- "Washington" | no single place (acceptable: Russia, Ukraine, Kyiv) | Kyiv |
| 10537 | GDELT Middle East | Breaking: Iran confirms death of Ayatollah Khamenei | **Doha** <- "Doha"; **Qatar** <- "Qatar"; **Israel** <- "Israel"; **Dubai** <- "Dubai" | Iran | Iran |
| 9174 | France 24 | South African judge awarded Nobel Peace Prize | **Kenya** <- "Kenya"; **Nairobi** <- "Nairobi" | no single place (acceptable: South Africa, Oslo, Norway) | Nairobi |
| 7429 | Al-Monitor | Portugal PM cautions judiciary not to get political over US use of air base | **Montenegro** <- "Montenegro"; **Iran** <- "Iran" | Portugal | Portugal, United States |
| 9741 | GDELT Middle East | A US-brokered ceasefire was supposed to end the war in Gaza. A year later, progress has stalled | **Indonesia** <- "Indonesia" | Gaza Strip | United States, Gaza Strip |
| 2247 | NK News | North Korea pledges to plant over 1 billion trees by next decade | **Mongolia** <- "Mongolia" | North Korea | North Korea |
| 989 | Jerusalem Post | 'Not yet out of danger': Israeli envoy to US shares update on son following terror attack | **United States** <- "US" | no single place (acceptable: Israel) | United States |
| 11228 | GDELT Middle East | Yemen govt forces claim gains against Houthis near key waterway | **Saudi Arabia** <- "Saudi Arabia"; **Riyadh** <- "Riyadh" | Yemen | Yemen |
