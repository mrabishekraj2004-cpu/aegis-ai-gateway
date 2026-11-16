local remaining = redis.call('PTTL', KEYS[1])
local requested = tonumber(ARGV[1]) * 1000
if requested > remaining then
    redis.call('SET', KEYS[1], '1', 'PX', requested)
end
return 1
