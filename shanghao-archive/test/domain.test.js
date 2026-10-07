import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHistDate, parseCnNumber, dateKey, detectCycle, validateCardBody, extractRefs, canonicalJson } from '../src/domain.js';

test('中文数字解析', () => {
  assert.equal(parseCnNumber('二十三'), 23);
  assert.equal(parseCnNumber('八'), 8);
  assert.equal(parseCnNumber('三十三'), 33);
  assert.equal(parseCnNumber('一百零五'), 105);
  assert.equal(parseCnNumber('23'), 23);
});

test('历史年代：民国精确换算、年号候选、原称保留', () => {
  const r1 = parseHistDate('民国二十三年');
  assert.equal(r1.year, 1934); assert.equal(r1.precision, 'year'); assert.equal(r1.raw, '民国二十三年');
  const r2 = parseHistDate('光绪三十三年');
  assert.equal(r2.year, 1907); assert.deepEqual(r2.candidateRange, [1907, 1907]);
  assert.equal(parseHistDate('光绪八年').year, 1882);
});

test('不确定年代：约词与区间精度保留，未知排最后', () => {
  const appr = parseHistDate('民国二十四年前后');
  assert.equal(appr.year, 1935); assert.equal(appr.approximate, true);
  const era = parseHistDate('光绪年间');
  assert.equal(era.precision, 'era'); assert.deepEqual(era.candidateRange, [1875, 1908]);
  const unk = parseHistDate('很久以前');
  assert.equal(unk.precision, 'unknown');
  assert.ok(dateKey(unk) > dateKey(parseHistDate('1934')));
  const spring = parseHistDate('一九五二年春');
  assert.equal(spring.year, 1952); assert.equal(spring.precision, 'month'); assert.equal(spring.month, 3);
});

test('卡片校验：陈述必须带出处、谓词须匹配类型', () => {
  const errs = validateCardBody('shop', {
    name: 'x',
    statements: [
      { predicate: 'bornOn', value: {}, sourceIds: ['S1'] }, // shop 不允许 bornOn
      { predicate: 'note', value: { text: 'a' } } // 缺出处
    ]
  });
  assert.equal(errs.length, 2);
});

test('结构性循环引用可被检测', () => {
  const mk = (id, refs) => ({
    id, mergedInto: null, akaPartOf: [],
    revisions: [{ id: id + 'r1', body: { name: id, statements: refs.map((to) => ({
      predicate: 'locatedAt', value: { placeId: to }, sourceIds: [] })) } }]
  });
  const cards = new Map([['A', mk('A', ['B'])], ['B', mk('B', ['C'])], ['C', mk('C', ['A'])]]);
  const cyc = detectCycle(cards, 'A');
  assert.ok(cyc); assert.ok(cyc.length >= 4);
  cards.get('C').revisions[0].body.statements = [];
  assert.equal(detectCycle(cards, 'A'), null);
});

test('引用边从嵌套陈述值中提取', () => {
  const edges = extractRefs({ predicate: 'relocatedTo', value: { placeId: 'L1', fromPlaceId: 'L2' }, sourceIds: [] });
  assert.deepEqual(edges.map((e) => e.to).sort(), ['L1', 'L2']);
});
