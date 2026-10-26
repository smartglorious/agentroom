const tenants = require("./tenants");
// Every game type registers a validator; an instance can only be published when its config passes.
const validators = new Map();
function registerValidator(type, fn) { validators.set(type, fn); }
function publishInstance(instance) {
  const validate = validators.get(instance.type);
  if (!validate) return { ok: false, errors: [`unknown game type ${instance.type}`] };
  const errors = validate(instance.config);
  if (errors.length) return { ok: false, errors };
  tenants.addInstance(instance);
  return { ok: true };
}
module.exports = { registerValidator, publishInstance };
