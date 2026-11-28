import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITIES } from '../src/entities.js';
import { renderMarkdown, decodeEntities } from '../src/markdown.js';

// The named character references the renderer decodes: a subset of HTML5's 2,125 (see
// src/entities.js for why). Any other name stays as written. A name added to or removed from
// the table must be added to or removed from this list.
const SUPPORTED = `
AElig Aacute Acirc Agrave Alpha Aring Atilde Auml Beta Ccedil Chi Dagger Delta ETH Eacute Ecirc
Egrave Epsilon Eta Euml Gamma Iacute Icirc Igrave Iota Iuml Kappa Lambda Mu Ntilde Nu OElig Oacute
Ocirc Ograve Omega Omicron Oslash Otilde Ouml Phi Pi Prime Psi Rho Scaron Sigma THORN Tau Theta
Uacute Ucirc Ugrave Upsilon Uuml Xi Yacute Yuml Zeta aacute acirc acute aelig agrave alefsym alpha
amp and ang aring asymp atilde auml bdquo beta brvbar bull cap ccedil cedil cent chi circ clubs cong
copy crarr cup curren dArr dagger darr deg delta diams divide eacute ecirc egrave empty emsp ensp
epsilon equiv eta eth euml euro exist fnof forall frac12 frac14 frac34 frasl gamma ge gt hArr harr
hearts hellip iacute icirc iexcl igrave image infin int iota iquest isin iuml kappa lArr lambda lang
laquo larr lceil ldquo le lfloor lowast loz lrm lsaquo lsquo lt macr mdash micro middot minus mu
nabla nbsp ndash ne ni not notin nsub ntilde nu oacute ocirc oelig ograve oline omega omicron oplus
or ordf ordm oslash otilde otimes ouml para part permil perp phi pi piv plusmn pound prime prod prop
psi quot rArr radic rang raquo rarr rceil rdquo real reg rfloor rho rlm rsaquo rsquo sbquo scaron
sdot sect shy sigma sigmaf sim spades sub sube sum sup sup1 sup2 sup3 supe szlig tau there4 theta
thetasym thinsp thorn tilde times trade uArr uacute uarr ucirc ugrave uml upsih upsilon uuml weierp
xi yacute yen yuml zeta zwj zwnj
apos check checkmark cross star starf phone female male sharp flat natural hyphen dash Tab NewLine
excl quest num dollar percnt lpar rpar ast plus comma period sol colon semi equals commat lsqb rsqb
bsol lowbar grave lcub rcub verbar vert Hat half mldr emsp13 emsp14 numsp puncsp hairsp
ZeroWidthSpace NoBreak map imath
ccaron Ccaron ecaron Ecaron rcaron Rcaron zcaron Zcaron ncaron Ncaron dcaron Dcaron tcaron Tcaron
uring Uring lstrok Lstrok nacute Nacute sacute Sacute zacute Zacute zdot Zdot aogon Aogon eogon
Eogon cacute Cacute gbreve Gbreve scedil Scedil Idot odblac Odblac udblac Udblac amacr Amacr emacr
Emacr imacr Imacr umacr Umacr omacr Omacr abreve Abreve lcaron Lcaron lacute Lacute racute Racute
eng ENG
leq geq approx pm mp setminus ell hbar copysr TRADE COPY REG AMP LT GT QUOT bullet ohm angle square
squ rect blacksquare cir bigcirc sung smile frown lrarr harrw rarrw nwarr nearr searr swarr varr iff
emptyset in subset supset wedge vee parallel par npar nexist coprod oint propto nequiv lsim gsim ll
gg prec succ langle rangle target bigstar spadesuit clubsuit heartsuit diamondsuit sext malt
`.trim().split(/\s+/);

test('the entity table is exactly the documented list', () => {
  assert.deepEqual([...ENTITIES.keys()].sort(), [...SUPPORTED].sort());
  assert.equal(SUPPORTED.length, 433);
});

test('entities decode to HTML5\'s characters', () => {
  const sample = {
    eacute: 'é', szlig: 'ß', ouml: 'ö', Ccaron: 'Č', uring: 'ů', lstrok: 'ł', odblac: 'ő', oelig: 'œ',
    nbsp: ' ', mdash: '—', hellip: '…', rarr: '→', ne: '≠', le: '≤', infin: '∞', alpha: 'α',
    Omega: 'Ω', euro: '€', copy: '©', trade: '™', lang: '⟨', rang: '⟩', colon: ':', Tab: '\t', check: '✓',
  };
  for (const [name, ch] of Object.entries(sample)) assert.equal(decodeEntities(`&${name};`), ch, name);
});

test('unknown names, and known ones without the semicolon, stay as written', () => {
  assert.equal(renderMarkdown('&bogus; &eacute &Eacute; &EACUTE;').replace(/ data-line="\d+"/, ''),
    '<p>&amp;bogus; &amp;eacute É &amp;EACUTE;</p>');
});
