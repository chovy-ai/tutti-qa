// Run with node <skill>/tests/test_case_selection.cjs; no external dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/case-mindmap/selection.js'), 'utf8') +
  '\nglobalThis.api = {CaseSelection, confirmationText};', context);
const {CaseSelection, confirmationText} = context.api;
const store = new Map();
const storage = {getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value)};
const ids = ['one', 'two', 'three'];
const model = new CaseSelection(ids, 'suite', storage);
assert.equal(model.inspect(ids).checked, true);
model.set(['one', 'two'], false); // Whole branch, including collapsed / filtered leaves.
assert.equal(model.inspect(['one', 'two']).count, 0);
assert.equal(model.inspect(ids).indeterminate, true);
model.set(['one'], true);
assert.equal(model.inspect(['one', 'two']).indeterminate, true);
assert.equal(new CaseSelection(ids, 'suite', storage).inspect(ids).count, 2);
assert.equal(new CaseSelection(ids, 'suite', null, model.snapshot()).inspect(ids).count, 2);

const meta = {batch: 'batch', hash: 'fingerprint',
  cases: [{id: 'one', keys: ['U0', 'U1']}, {id: 'two', keys: ['A0.0']}, {id: 'three', keys: []}],
  extraKeys: {'A0.1': ['one', 'two']}, allKeys: ['U0', 'U1', 'A0.0', 'A0.1']};
const decisions = () => JSON.parse(confirmationText(meta, model.selected).split('TUTTI-QA-CASES ')[1]).decisions;
assert.deepEqual(JSON.parse(JSON.stringify(decisions())).map(d => d.keep), [true, true, false, true]);
model.set(ids, false);
assert.equal(decisions().length, 4);
assert.equal(decisions().every(d => !d.keep), true);
model.set(['three'], true); // An unchanged case does not retain an unrelated note.
assert.equal(decisions().every(d => !d.keep), true);
assert.match(confirmationText(null, model.selected, 'suite'), /TUTTI-QA-SELECTION /);
assert.doesNotMatch(confirmationText(null, model.selected, 'suite'), /TUTTI-QA-CASES /);
assert.throws(() => model.set(['unknown'], true));
assert.throws(() => model.set(ids, 'false'));
assert.throws(() => model.restore({...model.snapshot(), suiteId: 'other'}));

const denied = new CaseSelection(ids, 'denied', {getItem() {throw Error('denied');}});
denied.set(ids, false);
assert.equal(denied.inspect(ids).count, 0);
assert.match(denied.notice, /暂存/);
console.log('PASS: cascade, half-selection, reload / HTML snapshots, complete confirmation mapping, denied storage.');
