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
    audit: (userId, action, detail) => database.users.audit(userId, action, detail)
  };
}
