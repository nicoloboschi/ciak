// Validate a value against the subset of JSON Schema that film.schema.json uses, with
// errors an agent can act on: the path, what was expected, and "did you mean" for typos.
const distance = (a, b) => {
  const row = Array.from({length: b.length + 1}, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const current = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = current; }
  }
  return row[b.length];
};

const typeOf = value => Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
const show = value => JSON.stringify(value)?.slice(0, 40);

// renamed: old field name → where it moved, so old films get a precise fix instead of a guess.
export function validate(root, value, renamed = {}) {
  const resolve = reference => reference.slice(2).split('/').reduce((node, key) => node[key], root);
  const errors = [];
  const walk = (schema, value, at) => {
    if (schema.$ref) return walk(resolve(schema.$ref), value, at);
    const before = errors.length;
    if (schema.const !== undefined && value !== schema.const) errors.push(`${at}: must be ${show(schema.const)}`);
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: must be one of ${schema.enum.map(show).join(', ')}, not ${show(value)}`);
    if (schema.type) {
      const types = [].concat(schema.type); const actual = typeOf(value);
      if (!types.includes(actual) && !(actual === 'integer' && types.includes('number'))) { errors.push(`${at}: must be ${types.join(' or ')}, not ${actual}`); return; }
    }
    if (schema.anyOf) {
      const results = schema.anyOf.map(option => { const saved = errors.length; walk(option, value, at); return errors.splice(saved); });
      if (results.every(result => result.length)) errors.push(schema.description ? `${at}: ${schema.description}` : results.sort((a, b) => a.length - b.length)[0][0]);
    }
    if (schema.discriminator && typeof value === 'object' && value) {
      // Pick the branch by the "type" field, so errors talk about the right kind of scene.
      const options = schema.oneOf.map(option => resolve(option.$ref));
      const branch = options.find(option => option.properties[schema.discriminator].const === value[schema.discriminator]);
      const kinds = options.map(option => option.properties[schema.discriminator].const);
      if (!branch) errors.push(`${at}.${schema.discriminator}: must be one of ${kinds.join(', ')}, not ${show(value[schema.discriminator])}`);
      else walk(branch, value, at);
      return;
    }
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: must be at least ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: must be at most ${schema.maximum}`);
    }
    if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: must match ${schema.pattern}`);
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} item(s)`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: allows at most ${schema.maxItems} item(s)`);
      if (schema.items) value.forEach((item, index) => walk(schema.items, item, `${at}[${index}]`));
    }
    if (typeOf(value) === 'object') {
      for (const key of schema.required || []) if (value[key] === undefined) errors.push(`${at}: missing "${key}"`);
      const known = Object.keys(schema.properties || {});
      for (const [key, item] of Object.entries(value)) {
        if (schema.properties?.[key]) walk(schema.properties[key], item, `${at}.${key}`);
        else if (schema.additionalProperties === false) {
          if (renamed[key] && !known.includes(key)) { errors.push(`${at}: "${key}" was renamed: use ${renamed[key]}`); continue; }
          const near = known.map(name => [name, distance(key.toLowerCase(), name.toLowerCase())]).sort((a, b) => a[1] - b[1])[0];
          const close = near && near[1] <= Math.max(1, Math.floor(key.length / 3));
          errors.push(`${at}: unknown field "${key}"${close ? ` (did you mean "${near[0]}"?)` : ''}; allowed: ${known.join(', ')}`);
        } else if (typeof schema.additionalProperties === 'object') walk(schema.additionalProperties, item, `${at}.${key}`);
      }
    }
    return errors.length === before;
  };
  walk(root, value, 'film');
  return errors;
}
