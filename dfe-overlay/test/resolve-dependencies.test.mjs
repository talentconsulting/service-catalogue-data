import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findGatewayArea, innerApiFor, resolveDependencies } from '../resolve-dependencies.mjs';

const overlay = {
  gateway: {
    repo: 'das-apim-endpoints',
    label: 'APIM',
    hideInLandscape: true,
    areas: {
      Approvals: { match: [{ configurationKey: 'ApprovalsOuterApiConfiguration' }, { name: 'Approvals Outer' }] },
      EmployerAccounts: { match: [{ repo: 'das-employer-accounts', configurationKey: 'OuterApiConfiguration' }] },
      Missing: { match: [{ name: 'Missing Outer' }] }
    }
  },
  additionalCalls: [
    { repo: 'das-reservations', sourceId: 'web', name: 'Reservations Outer API', configurationKeys: ['ApprovalsOuterApiConfiguration'], evidence: [{ sourceFile: 'Client.cs', reason: 'overlay' }] }
  ],
  innerApis: {
    CoursesApiConfiguration: { name: 'Courses API', repo: 'das-courses-api' },
    CommitmentsV2ApiConfiguration: { name: 'Commitments API', repo: 'das-commitments', names: ['Commitments V2'] },
    ReservationApiConfiguration: { name: 'Reservations API', repo: 'das-reservations-api', names: ['Reservations'] }
  }
};

const routes = {
  commit: 'abc123',
  areas: {
    Approvals: {
      innerApis: [
        { configuration: 'CommitmentsV2ApiConfiguration', clients: ['InternalApiClient'], usages: 9, evidence: ['src/Approvals/Commitments.cs'] },
        { configuration: 'CoursesApiConfiguration', clients: ['ICoursesApiClient'], usages: 4, evidence: ['src/Approvals/Courses.cs'] },
        { configuration: 'ProviderRelationshipsApiConfiguration', clients: ['IProviderRelationshipsApiClient'], usages: 1, evidence: ['src/Approvals/Pr.cs'] }
      ]
    }
  }
};

const catalogued = new Set(['das-commitments', 'das-courses-api', 'das-reservations', 'das-reservations-api', 'das-apim-endpoints']);
const context = { overlay, routes, catalogued };
const http = (name, configurationKeys = [], extra = {}) => ({ sourceId: 'api', name, kind: 'http-api', direction: 'outbound', configurationKeys, operations: [], evidence: [{ sourceFile: 'Startup.cs', reason: 'registration' }], ...extra });

test('an APIM call is replaced by the inner APIs its area calls', () => {
  const resolved = resolveDependencies({ dependencies: [http('Approvals Outer', ['ApprovalsOuterApiConfiguration:ApiBaseUrl'])] }, 'das-providercommitments', context);
  const names = resolved.dependencies.map((dependency) => dependency.name);
  assert.deepEqual(names, ['Commitments API', 'Courses API', 'Provider Relationships API']);
  const courses = resolved.dependencies[1];
  assert.equal(courses.targetRepo, 'das-courses-api');
  assert.equal(courses.via.area, 'Approvals');
  assert.equal(courses.via.dependencyName, 'Approvals Outer');
  assert.equal(courses.description, 'Calls via APIM (Approvals)');
  assert.ok(courses.evidence.some((item) => item.sourceFile === 'das-apim-endpoints/src/Approvals/Courses.cs'));
  assert.equal(resolved.resolution.apimCommit, 'abc123');
});

test('an inner API outside the catalogue keeps its name but gets no targetRepo', () => {
  const resolved = resolveDependencies({ dependencies: [http('Approvals Outer')] }, 'das-providercommitments', context);
  const relationships = resolved.dependencies.find((dependency) => dependency.name === 'Provider Relationships API');
  assert.equal(relationships.targetRepo, undefined);
  assert.equal(relationships.targetId, 'http-api-provider-relationships-api');
});

test('a caller is not routed back to itself', () => {
  const resolved = resolveDependencies({ dependencies: [http('Approvals Outer')] }, 'das-commitments', context);
  assert.ok(!resolved.dependencies.some((dependency) => dependency.targetRepo === 'das-commitments'));
});

test('repo-scoped rules only match their own repository', () => {
  const dependency = http('Outer API', ['OuterApiConfiguration.BaseUrl']);
  assert.equal(findGatewayArea(dependency, 'das-employer-accounts', overlay), 'EmployerAccounts');
  assert.equal(findGatewayArea(dependency, 'das-employer-finance', overlay), null);
});

test('direct calls the overlay recognises are pinned to their repository', () => {
  const resolved = resolveDependencies({ dependencies: [http('Reservations'), http('Something Else')] }, 'das-commitments', context);
  assert.equal(resolved.dependencies[0].targetRepo, 'das-reservations-api');
  assert.equal(resolved.dependencies[0].via, undefined);
  assert.equal(resolved.dependencies[1].targetRepo, undefined);
});

test('additional calls fill gaps in the scan', () => {
  const resolved = resolveDependencies({ dependencies: [] }, 'das-reservations', context);
  assert.ok(resolved.dependencies.some((dependency) => dependency.sourceId === 'web' && dependency.targetRepo === 'das-courses-api'));
});

test('two calls into the same area from one container produce one dependency per target', () => {
  const resolved = resolveDependencies({ dependencies: [http('Approvals Outer'), http('Approvals Outer API', ['ApprovalsOuterApiConfiguration'])] }, 'das-providercommitments', context);
  assert.equal(resolved.dependencies.filter((dependency) => dependency.name === 'Courses API').length, 1);
});

test('an area with no extracted routes is kept and flagged unresolved', () => {
  const resolved = resolveDependencies({ dependencies: [http('Missing Outer')] }, 'das-providercommitments', context);
  assert.equal(resolved.dependencies.length, 1);
  assert.equal(resolved.dependencies[0].via.unresolved, true);
});

test('the gateway itself is marked so the landscape can hide it', () => {
  const resolved = resolveDependencies({ dependencies: [http('Courses')] }, 'das-apim-endpoints', context);
  assert.equal(resolved.role, 'gateway');
  assert.equal(resolved.hideInLandscape, true);
});

test('inner APIs missing from the overlay get a readable name', () => {
  assert.equal(innerApiFor('ProviderRelationshipsApiConfiguration', overlay).name, 'Provider Relationships API');
  assert.equal(innerApiFor('LearnerDataInnerApiConfiguration', overlay).name, 'Learner Data API');
});
