const path = require('path');
const express = require('express');
const redis = require('redis');
const bcrypt = require('bcrypt');
const session = require('express-session');
const { promisify } = require('util');
const { formatDistance } = require('date-fns');

const app = express();
const client = redis.createClient();
const RedisStore = require('connect-redis')(session);
const ahget = promisify(client.hget).bind(client);
const asmembers = promisify(client.smembers).bind(client);
const ahkeys = promisify(client.hkeys).bind(client);
const aincr = promisify(client.incr).bind(client);
const alrange = promisify(client.lrange).bind(client);

app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    store: new RedisStore({ client }),
    resave: true,
    saveUninitialized: true,
    cookie: {
      maxAge: 36000000,
      httpOnly: false,
      secure: false,
    },
    secret: '77QgxaX>&\VeEWe',
  })
);

app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views'));

app.get('/', async (req, res) => {
  if (req.session.userid) {
    try {
      const currentUsername = await ahget(`user:${req.session.userid}`, 'username');
      const following = await asmembers(`following:${currentUsername}`);
      const users = await ahkeys('users');
      const timeline = [];
      const posts = await alrange(`timeline:${currentUsername}`, 0, 20);
      for (const post of posts) {
        const timestamp = await ahget(`post:${post}`, 'timestamp');
        const timeString = formatDistance(
          new Date(),
          new Date(parseInt(timestamp))
        );

        timeline.push({
          message: await ahget(`post:${post}`, 'message'),
          author: await ahget(`post:${post}`, 'username'),
          timeString,
        });
      }

      res.render('dashboard', {
        users: users.filter(user => user !== currentUsername && !following.includes(user)),
        currentUsername,
        timeline,
      });
    } catch (err) {
      res.render('error', { message: err.message });
    }
  } else {
    res.render('login');
  }
});

app.post('/', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.render('error', { message: 'Please set both username and password' });
    return;
  }

  const saveSessionAndRenderDashboard = userid => {
    req.session.userid = userid;
    req.session.save();
    res.redirect('/');
  };

  const handleSignup = async (username, password) => {
    const userid = await aincr('userid');
    client.hset('users', username, userid);
    const saltRounds = 10;
    const hash = await bcrypt.hash(password, saltRounds);
    client.hset(`user:${userid}`, 'hash', hash, 'username', username);
    saveSessionAndRenderDashboard(userid);
  };

  const handleLogin = async (userid, password) => {
    const hash = await ahget(`user:${userid}`, 'hash');
    const result = await bcrypt.compare(password, hash);
    if (result) {
      saveSessionAndRenderDashboard(userid);
    } else {
      throw new Error('Incorrect password');
    }
  };
  
  try {
    const userid = await ahget('users', username);
    if (!userid) {
      handleSignup(username, password);
    } else {
      handleLogin(userid, password);
    }
  } catch (err) {
    res.render('error', { message: err.message });
  }
});

app.get('/post', (req, res) => {
  if (req.session.userid) {
    res.render('post');
  } else {
    res.render('login');
  }
});

app.post('/post', async (req, res) => {
  if (!req.session.userid) {
    res.render('login');
    return;
  }

  const { message } = req.body;
  try {
    const postid = await aincr('postid');
    const currentUsername = await ahget(`user:${req.session.userid}`, 'username');
    client.hmset(`post:${postid}`, 'userid', req.session.userid, 'username', currentUsername, 'message', message, 'timestamp', Date.now());
    client.lpush(`timeline:${currentUsername}`, postid);
    const followers = await asmembers(`followers:${currentUsername}`);
    for (const follower of followers) {
      client.lpush(`timeline:${follower}`, postid);
    }

    res.redirect('/');
  } catch (err) {
    res.render('error', { message: err.message });
  }
});

app.post('/follow', async (req, res) => {
  if (!req.session.userid) {
    res.render('login');
    return;
  }

  const { username } = req.body;
  try {
    const currentUsername = await ahget(`user:${req.session.userid}`, 'username');
    client.sadd(`following:${currentUsername}`, username);
    client.sadd(`followers:${username}`, currentUsername);
    res.redirect('/');
  } catch (err) {
    res.render('error', { message: err.message });
  }
});

app.get('/sign-out', async (req, res) => {
  try {
    if (req.session.userid) {
      const sessionDestroy = promisify(req.session.destroy).bind(req.session);
      await sessionDestroy();
    }

    res.redirect('/');
  } catch (err) {
    res.redirect('error', { message: err.message });
  }
});

app.listen(3000, () => console.log('Server ready'));

