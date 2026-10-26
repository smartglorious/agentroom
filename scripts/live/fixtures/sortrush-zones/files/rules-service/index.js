// Loads every game so its routes and validators are registered.
require("./tapFrenzy");
module.exports = { http: require("./http"), db: require("./db"), tenants: require("./tenants"), configs: require("./configs"), rewards: require("./rewards"), sessions: require("./gameSessions") };
