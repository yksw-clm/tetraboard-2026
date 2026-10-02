SELECT json_object(
  'users', json((SELECT json_group_array(json_object(
    'id', id, 'name', name, 'email', email, 'emailVerified', emailVerified,
    'image', image, 'createdAt', createdAt, 'updatedAt', updatedAt,
    'username', username, 'profileCompleted', profileCompleted, 'avatarKey', avatarKey
  )) FROM user WHERE COALESCE(isAnonymous, 0) = 0 AND COALESCE(isTestUser, 0) = 0)),
  'accounts', json((SELECT json_group_array(json_object(
    'id', a.id, 'accountId', a.accountId, 'providerId', a.providerId,
    'userId', a.userId, 'createdAt', a.createdAt, 'updatedAt', a.updatedAt
  )) FROM account a JOIN user u ON u.id = a.userId
    WHERE COALESCE(u.isAnonymous, 0) = 0 AND COALESCE(u.isTestUser, 0) = 0))
) AS snapshot;
