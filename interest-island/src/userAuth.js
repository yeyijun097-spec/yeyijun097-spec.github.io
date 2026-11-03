export function createUserAuth(database) {
  return {
    authenticate: (username, password) => database.users.authenticate(username, password),
    listUsers: () => database.users.list(),
    getUser: (id) => database.users.getById(id),
    createUser: (input) => database.users.create(input),
    setDisabled: (id, disabled) => database.users.setDisabled(id, disabled),
    setPassword: (id, password, mustChangePassword = false) => database.users.setPassword(id, password, mustChangePassword),
    deleteUser: (id) => database.users.delete(id),
    countAdmins: () => database.users.countAdmins(),
    countUsers: () => database.users.countUsers(),
    taskQuotaStatus: (userId, role) => role === "admin"
      ? { unlimited: true }
      : { unlimited: false, quotas: database.taskQuotas.all(userId) },
    consumeTaskQuota: (userId, role, taskType, amount = 1) => role === "admin"
      ? { unlimited: true }
      : database.taskQuotas.consume(userId, taskType, amount),
    refundTaskQuota: (userId, role, taskType, amount = 1) => role === "admin"
      ? { unlimited: true }
      : database.taskQuotas.refund(userId, taskType, amount),
    grantTaskQuota: (userId, role, taskType) => {
      if (role === "admin") {
        const error = new Error("管理员账号不受每日任务额度限制");
        error.statusCode = 400;
        throw error;
      }
      return database.taskQuotas.grant(userId, taskType);
    },
    audit: (userId, action, detail) => database.users.audit(userId, action, detail)
  };
}
