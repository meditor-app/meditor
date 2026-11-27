// HTML named character references: a chosen subset of HTML5's 2,125.
//
// The full table would be about 25 KB, more than the rest of the renderer's data put
// together, for names documents practically never use. This keeps all of HTML 4's 252
// (Latin-1, Greek, arrows, maths and typographic symbols, with HTML5's values), the Latin
// Extended-A letters of Central European languages (č, ř, ů, ł, ő, …), ASCII punctuation
// spelled out (&colon;, &lpar;, …) and a few common symbols. Any other name stays as
// written, escaped. tests/entities.test.js lists them.

const TABLE = `
AElig:c6 Aacute:c1 Acirc:c2 Agrave:c0 Alpha:391 Aring:c5 Atilde:c3 Auml:c4 Beta:392 Ccedil:c7
Chi:3a7 Dagger:2021 Delta:394 ETH:d0 Eacute:c9 Ecirc:ca Egrave:c8 Epsilon:395 Eta:397 Euml:cb
Gamma:393 Iacute:cd Icirc:ce Igrave:cc Iota:399 Iuml:cf Kappa:39a Lambda:39b Mu:39c Ntilde:d1
Nu:39d OElig:152 Oacute:d3 Ocirc:d4 Ograve:d2 Omega:3a9 Omicron:39f Oslash:d8 Otilde:d5 Ouml:d6
Phi:3a6 Pi:3a0 Prime:2033 Psi:3a8 Rho:3a1 Scaron:160 Sigma:3a3 THORN:de Tau:3a4 Theta:398
Uacute:da Ucirc:db Ugrave:d9 Upsilon:3a5 Uuml:dc Xi:39e Yacute:dd Yuml:178 Zeta:396 aacute:e1
acirc:e2 acute:b4 aelig:e6 agrave:e0 alefsym:2135 alpha:3b1 amp:26 and:2227 ang:2220 aring:e5
asymp:2248 atilde:e3 auml:e4 bdquo:201e beta:3b2 brvbar:a6 bull:2022 cap:2229 ccedil:e7 cedil:b8
cent:a2 chi:3c7 circ:2c6 clubs:2663 cong:2245 copy:a9 crarr:21b5 cup:222a curren:a4 dArr:21d3
dagger:2020 darr:2193 deg:b0 delta:3b4 diams:2666 divide:f7 eacute:e9 ecirc:ea egrave:e8
empty:2205 emsp:2003 ensp:2002 epsilon:3b5 equiv:2261 eta:3b7 eth:f0 euml:eb euro:20ac exist:2203
fnof:192 forall:2200 frac12:bd frac14:bc frac34:be frasl:2044 gamma:3b3 ge:2265 gt:3e hArr:21d4
harr:2194 hearts:2665 hellip:2026 iacute:ed icirc:ee iexcl:a1 igrave:ec image:2111 infin:221e
int:222b iota:3b9 iquest:bf isin:2208 iuml:ef kappa:3ba lArr:21d0 lambda:3bb lang:27e8 laquo:ab
larr:2190 lceil:2308 ldquo:201c le:2264 lfloor:230a lowast:2217 loz:25ca lrm:200e lsaquo:2039
lsquo:2018 lt:3c macr:af mdash:2014 micro:b5 middot:b7 minus:2212 mu:3bc nabla:2207 nbsp:a0
ndash:2013 ne:2260 ni:220b not:ac notin:2209 nsub:2284 ntilde:f1 nu:3bd oacute:f3 ocirc:f4
oelig:153 ograve:f2 oline:203e omega:3c9 omicron:3bf oplus:2295 or:2228 ordf:aa ordm:ba oslash:f8
otilde:f5 otimes:2297 ouml:f6 para:b6 part:2202 permil:2030 perp:22a5 phi:3c6 pi:3c0 piv:3d6
plusmn:b1 pound:a3 prime:2032 prod:220f prop:221d psi:3c8 quot:22 rArr:21d2 radic:221a rang:27e9
raquo:bb rarr:2192 rceil:2309 rdquo:201d real:211c reg:ae rfloor:230b rho:3c1 rlm:200f
rsaquo:203a rsquo:2019 sbquo:201a scaron:161 sdot:22c5 sect:a7 shy:ad sigma:3c3 sigmaf:3c2
sim:223c spades:2660 sub:2282 sube:2286 sum:2211 sup:2283 sup1:b9 sup2:b2 sup3:b3 supe:2287
szlig:df tau:3c4 there4:2234 theta:3b8 thetasym:3d1 thinsp:2009 thorn:fe tilde:2dc times:d7
trade:2122 uArr:21d1 uacute:fa uarr:2191 ucirc:fb ugrave:f9 uml:a8 upsih:3d2 upsilon:3c5 uuml:fc
weierp:2118 xi:3be yacute:fd yen:a5 yuml:ff zeta:3b6 zwj:200d zwnj:200c
apos:27 check:2713 checkmark:2713 cross:2717 star:2606 starf:2605 phone:260e female:2640
male:2642 sharp:266f flat:266d natural:266e hyphen:2010 dash:2010 Tab:9 NewLine:a excl:21
quest:3f num:23 dollar:24 percnt:25 lpar:28 rpar:29 ast:2a plus:2b comma:2c period:2e sol:2f
colon:3a semi:3b equals:3d commat:40 lsqb:5b rsqb:5d bsol:5c lowbar:5f grave:60 lcub:7b rcub:7d
verbar:7c vert:7c Hat:5e half:bd mldr:2026 emsp13:2004 emsp14:2005 numsp:2007 puncsp:2008
hairsp:200a ZeroWidthSpace:200b NoBreak:2060 map:21a6 imath:131
ccaron:10d Ccaron:10c ecaron:11b Ecaron:11a rcaron:159 Rcaron:158 zcaron:17e Zcaron:17d
ncaron:148 Ncaron:147 dcaron:10f Dcaron:10e tcaron:165 Tcaron:164 uring:16f Uring:16e
lstrok:142 Lstrok:141 nacute:144 Nacute:143 sacute:15b Sacute:15a zacute:17a Zacute:179
zdot:17c Zdot:17b aogon:105 Aogon:104 eogon:119 Eogon:118 cacute:107 Cacute:106 gbreve:11f
Gbreve:11e scedil:15f Scedil:15e Idot:130 odblac:151 Odblac:150 udblac:171 Udblac:170 amacr:101
Amacr:100 emacr:113 Emacr:112 imacr:12b Imacr:12a umacr:16b Umacr:16a omacr:14d Omacr:14c
abreve:103 Abreve:102 lcaron:13e Lcaron:13d lacute:13a Lacute:139 racute:155 Racute:154 eng:14b
ENG:14a leq:2264 geq:2265 approx:2248 pm:b1 mp:2213 setminus:2216 ell:2113 hbar:210f copysr:2117
TRADE:2122 COPY:a9 REG:ae AMP:26 LT:3c GT:3e QUOT:22 bullet:2022 ohm:3a9 angle:2220 square:25a1
squ:25a1 rect:25ad blacksquare:25aa cir:25cb bigcirc:25ef sung:266a smile:2323 frown:2322
lrarr:21c6 harrw:21ad rarrw:219d nwarr:2196 nearr:2197 searr:2198 swarr:2199 varr:2195 iff:21d4
emptyset:2205 in:2208 subset:2282 supset:2283 wedge:2227 vee:2228 parallel:2225 par:2225
npar:2226 nexist:2204 coprod:2210 oint:222e propto:221d nequiv:2262 lsim:2272 gsim:2273 ll:226a
gg:226b prec:227a succ:227b langle:27e8 rangle:27e9 target:2316 bigstar:2605 spadesuit:2660
clubsuit:2663 heartsuit:2665 diamondsuit:2666 sext:2736 malt:2720
`;

/** Entity name (without & and ;) → the text it stands for. */
export const ENTITIES = new Map(TABLE.trim().split(/\s+/).map((e) => {
  const [name, cp] = e.split(':');
  return [name, String.fromCodePoint(parseInt(cp, 16))];
}));
