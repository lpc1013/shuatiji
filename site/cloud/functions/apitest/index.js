exports.main = async (event, context) => {
  return {
    ok: true,
    got: event,
    env: (context && context.env) || null,
  };
};
