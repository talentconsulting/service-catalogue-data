// Converts a repository's generated OpenAPI specs into a single Postman Collection v2.1
// (one folder per spec file) plus a companion environment file seeded from local-dev-config.json.
// No secrets are ever embedded — local-dev-config.json only records config *key names* found by
// evidence-based scanning, never actual values, so every variable ships empty for the user to fill in.

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

const RELEVANT_CONFIG_KEYWORDS = ['baseurl', 'url', 'clientid', 'clientsecret', 'tenant', 'apikey', 'secret', 'token', 'identifieruri', 'audience'];

function exampleForSchema(schema, components, seen = new Set()) {
  if (!schema) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', '');
    if (seen.has(name)) return {};
    const resolved = components?.schemas?.[name];
    return resolved ? exampleForSchema(resolved, components, new Set([...seen, name])) : {};
  }
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === 'array') return [exampleForSchema(schema.items || {}, components, seen)];
  if (schema.type === 'object' || schema.properties) {
    const obj = {};
    for (const [key, propSchema] of Object.entries(schema.properties || {})) obj[key] = exampleForSchema(propSchema, components, seen);
    return obj;
  }
  if (schema.type === 'integer' || schema.type === 'number') return 0;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'string') {
    if (schema.format === 'date-time') return '2024-01-01T00:00:00Z';
    if (schema.format === 'date') return '2024-01-01';
    if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
    return '';
  }
  return null;
}

function convertPath(path) {
  const paramNames = [];
  const segments = path.split('/').filter(Boolean).map((segment) => {
    const match = segment.match(/^\{(.+)\}$/);
    if (!match) return segment;
    paramNames.push(match[1]);
    return `:${match[1]}`;
  });
  return { segments, paramNames };
}

function buildRequestItem(path, method, operation, components) {
  const { segments, paramNames } = convertPath(path);
  const pathParams = (operation.parameters || []).filter((p) => p.in === 'path');
  const queryParams = (operation.parameters || []).filter((p) => p.in === 'query');
  const headerParams = (operation.parameters || []).filter((p) => p.in === 'header');

  const header = headerParams.map((p) => ({ key: p.name, value: '', description: p.description || '' }));
  let body;
  const media = operation.requestBody?.content?.['application/json'] || Object.values(operation.requestBody?.content || {})[0];
  if (media?.schema) {
    header.push({ key: 'Content-Type', value: 'application/json' });
    body = { mode: 'raw', raw: JSON.stringify(exampleForSchema(media.schema, components), null, 2), options: { raw: { language: 'json' } } };
  }

  return {
    name: `${method.toUpperCase()} ${path}`,
    request: {
      method: method.toUpperCase(),
      header,
      url: {
        raw: `{{baseUrl}}/${segments.join('/')}${queryParams.length ? `?${queryParams.map((p) => `${p.name}=`).join('&')}` : ''}`,
        host: ['{{baseUrl}}'],
        path: segments,
        variable: paramNames.map((name) => ({ key: name, value: '', description: pathParams.find((p) => p.name === name)?.description || '' })),
        query: queryParams.map((p) => ({ key: p.name, value: '', description: p.description || '', disabled: !p.required }))
      },
      ...(body ? { body } : {}),
      description: operation.summary || operation.operationId || ''
    },
    response: []
  };
}

function buildFolder(fileName, spec) {
  const item = [];
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of HTTP_METHODS) {
      if (pathItem[method]) item.push(buildRequestItem(path, method, pathItem[method], spec.components));
    }
  }
  return { name: fileName.replace(/\.openapi\.json$/, ''), item };
}

function hasBearerAuth(specs) {
  return specs.some((spec) => Object.values(spec.components?.securitySchemes || {})
    .some((scheme) => scheme.type === 'oauth2' || (scheme.type === 'http' && (scheme.scheme || '').toLowerCase() === 'bearer')));
}

export function buildPostmanCollection(repoName, specFiles) {
  const bearer = hasBearerAuth(specFiles.map((f) => f.spec));
  const collection = {
    info: {
      name: repoName,
      description: `Generated from the OpenAPI specs cataloged for ${repoName}. Set the "baseUrl" collection variable to your local/dev instance before sending requests.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    item: specFiles.map((f) => buildFolder(f.name, f.spec)),
    variable: [{ key: 'baseUrl', value: '', description: 'Base URL of your local/dev instance of this API, e.g. https://localhost:5001' }]
  };
  if (bearer) {
    collection.auth = { type: 'bearer', bearer: [{ key: 'token', value: '{{bearerToken}}', type: 'string' }] };
    collection.variable.push({ key: 'bearerToken', value: '', description: 'Bearer token / JWT for authenticated requests' });
  }
  return collection;
}

export function buildPostmanEnvironment(repoName, specFiles, localDevConfig) {
  const values = [
    { key: 'baseUrl', value: '', type: 'default', enabled: true, description: 'Base URL of your local/dev instance of this API, e.g. https://localhost:5001' }
  ];
  if (hasBearerAuth(specFiles.map((f) => f.spec))) {
    values.push({ key: 'bearerToken', value: '', type: 'secret', enabled: true, description: 'Bearer token / JWT for authenticated requests' });
  }
  const configKeys = [...new Set((localDevConfig?.configurationKeys || []).map((entry) => entry.key))];
  const relevant = configKeys.filter((key) => RELEVANT_CONFIG_KEYWORDS.some((word) => key.toLowerCase().includes(word))).sort();
  for (const key of relevant) values.push({ key, value: '', type: 'secret', enabled: true });

  return { name: `${repoName} (local)`, values, _postman_variable_scope: 'environment' };
}
