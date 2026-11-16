local now = redis.call('TIME')
local ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local action, owner, bound = ARGV[1], ARGV[2], tonumber(ARGV[3])
local key = KEYS[1]
if action == 'release' then return redis.call('ZREM', key, owner) end
redis.call('ZREMRANGEBYSCORE', key, '-inf', ms)
if action == 'acquire' then
    if redis.call('ZCARD', key) >= bound then return 0 end
elseif redis.call('ZSCORE', key, owner) == false then
    return 0
end
redis.call('ZADD', key, ms + 30000, owner)
redis.call('EXPIRE', key, 120)
return 1
