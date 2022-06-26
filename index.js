const mode = 'prod'
if (mode === 'dev') {
    require('dotenv').config({ path: '.env' })
}
var express = require('express'); // Express web server framework
var axios = require('axios');
var cors = require('cors');
var qs = require('qs');
var cookieParser = require('cookie-parser');
const { ObjectId } = require('mongodb');
const MongoClient = require('mongodb').MongoClient
const database = new MongoClient(process.env.MONGOURI, { useNewUrlParser: true, useUnifiedTopology: true })


var client_id = '220e69c3d40c4c1c8b2106c9502c0716'; // Your client id
var client_secret = process.env.SPOTIFYSECRET; // Your secret
if (mode === 'prod') {
    var redirect_uri = 'https://spotify-compilation-playlist.vercel.app/'; // Your redirect uri
} else {
    var redirect_uri = 'http://localhost:8080/callback'; // Your redirect uri
}


/**
 * Generates a random string containing numbers and letters
 * @param  {number} length The length of the string
 * @return {string} The generated string
 */
var generateRandomString = function (length) {
    var text = '';
    var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    for (var i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
};

var stateKey = 'spotify_auth_state';

var app = express();

app.use(express.static(__dirname + '/public'))
    .use(cors())
    .use(cookieParser());

app.get('/login', function (req, res) {

    var state = generateRandomString(16);
    res.cookie(stateKey, state);

    // your application requests authorization
    var scope = 'playlist-modify-public playlist-modify-private playlist-read-private playlist-read-collaborative';
    res.redirect('https://accounts.spotify.com/authorize?' +
        qs.stringify({
            response_type: 'code',
            client_id: client_id,
            scope: scope,
            redirect_uri: redirect_uri,
            state: state
        }));
});

app.get('/callback', function (req, res) {

    // your application requests refresh and access tokens
    // after checking the state parameter

    var code = req.query.code || null;
    var state = req.query.state || null;
    var storedState = req.cookies ? req.cookies[stateKey] : null;

    if (state === null || state !== storedState) {
        res.redirect('/#' +
            qs.stringify({
                error: 'state_mismatch'
            }));
    } else {
        res.clearCookie(stateKey);

        var callbackData = qs.stringify({
            code: code,
            grant_type: 'authorization_code',
            redirect_uri: redirect_uri
        })

        var callbackConfig = {
            method: 'post',
            url: 'https://accounts.spotify.com/api/token',
            headers: {
                'Authorization': 'Basic ' + (Buffer.from(client_id + ':' + client_secret).toString('base64')),
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            data: callbackData
        }

        axios(callbackConfig)
            .then(async function (response) {
                var writeData = response.data
                var access_token = response.data.access_token,
                    refresh_token = response.data.refresh_token;
                writeData.exp = new Date().getTime() + (response.data.expires_in * 1000)
                await fs.writeFile('auth.json', JSON.stringify(writeData))
                database.connect(async (err, dbClient) => {
                    if (err) console.error(err)
                    const collection = dbClient.db('spotifycompDB').collection('auth')
                    await collection.updateOne({ token_type: "Bearer" }, { $set: writeData })
                    database.close()
                })

                // we can also pass the token to the browser to make requests from there - hiding this as of now so people dont take the account token.
                res.redirect('/#' +
                    qs.stringify({
                        access_token: access_token,
                        refresh_token: refresh_token
                    }));

            })
            .catch(function (error) {
                console.log(error)
                res.redirect('/#' +
                    qs.stringify({
                        error: 'invalid_token'
                    }));
            });
    }
});

app.get('/refresh_token', function (req, res) {
    // function refreshToken(refresh_token) {
    // requesting access token from refresh token
    // return new Promise((resolve, reject) => {
    database.connect(async (err, dbClient) => {
        var collectionFind = await dbClient.db('spotifycompDB').collection('auth').find({ token_type: "Bearer" }).toArray()
        collectionFind = collectionFind[0]

        var refreshData = qs.stringify({
            grant_type: 'refresh_token',
            refresh_token: collectionFind.refresh_token
        })


        var config = {
            method: 'post',
            url: 'https://accounts.spotify.com/api/token',
            headers: {
                'Authorization': 'Basic ' + (Buffer.from(client_id + ':' + client_secret).toString('base64')),
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            data: refreshData
        };

        axios(config)
            .then(async function (response) {
                console.log(JSON.stringify(response.data));
                var writeData = response.data
                writeData.exp = new Date().getTime() + (response.data.expires_in * 1000)
                // await fs.writeFile('auth.json', JSON.stringify(response.data))
                database.connect(async (err, dbClient) => {
                    if (err) console.error(err)
                    const collection = dbClient.db('spotifycompDB').collection('auth')
                    await collection.updateOne({ token_type: "Bearer" }, { $set: writeData })
                    database.close()
                    res.sendStatus(200)
                })
            })
            .catch(function (error) {
                console.log(error);
            });
        // })
        database.close()
    })
})


app.get('/pull_songs', (req, res) => {
    database.connect(async (err, dbClient) => {
        var authinfo = await dbClient.db('spotifycompDB').collection('auth').find({ token_type: "Bearer" }).toArray()
        authinfo = authinfo[0]
        var playlists = await dbClient.db('spotifycompDB').collection('playlists').find({ locator: "playlists" }).toArray()
        playlists = playlists[0].playlists.map(playlist => playlist.id)
        var tracks = []
        for (i = 0; i < playlists.length; i++) {
            // tracks = tracks.concat(await exec(authinfo, playlists))
            tracks = [...new Set([...tracks, ...await exec(authinfo, playlists)])]
        }
        const collectionURI = dbClient.db('spotifycompDB').collection('uris')
        
        await collectionURI.updateOne({ tracking: 'trackList' }, { $set: { arr: tracks } })

        database.close()
        res.sendStatus(200)

        // prob should use recursion here but whatever this is a botch
        async function exec(authinfo, playlists) {
            return new Promise((resolve, reject) => {
                var getTracks = {
                    method: 'get',
                    url: `https://api.spotify.com/v1/playlists/${playlists[i]}/tracks?fields=items(track(uri)),next`,
                    headers: {
                        'Authorization': `Bearer ${authinfo.access_token}`
                    }
                }
                axios(getTracks).then(async function (tracksRes) {
                    var resolveTrack = []
                    var tempTracks = tracksRes.data.items.map(track => track.track.uri)
                    resolveTrack.push(...tempTracks)
                    if (tracksRes.data.next) {
                        var next = true
                        var nextURL = tracksRes.data.next
                    } else {
                        resolve(resolveTrack)
                    }
                    while (next) {
                        var nextResults = await getMoreTracks(authinfo, nextURL)
                        tempTracks = nextResults.data.items.map(track => track.track.uri)
                        resolveTrack = resolveTrack.concat(tempTracks)
                        if (nextResults.data.next) {
                            nextURL = nextResults.data.next
                        } else {
                            next = false
                            resolve(resolveTrack)
                        }
                    }
                })
            })
        }

        async function getMoreTracks(authinfo, next) {
            return new Promise((resolve, reject) => {
                var getMoreTracks = {
                    method: 'get',
                    url: next,
                    headers: {
                        'Authorization': `Bearer ${authinfo.access_token}`
                    }
                }
                axios(getMoreTracks).then(async function (tracksRes) {
                    // var tempTracks = tracksRes.data.tracks.items.map(track => track.track.uri)
                    resolve(tracksRes)
                })
            })
        }


    })
})

app.get('/update_playlist', (res, req) => {
    database.connect(async (err, dbClient) => {
        var authinfo = await dbClient.db('spotifycompDB').collection('auth').find({ token_type: "Bearer" }).toArray()
        authinfo = authinfo[0]
        var tracks = await dbClient.db('spotifycompDB').collection('uris').find({ tracking: "trackList" }).toArray()
        tracks = tracks[0].arr.filter(x => !x.includes('spotify:local:'))

        // replace current playlist with new playlist items in iterations of 100 songs each request
        var replaceList = {
            method: 'put',
            url: `https://api.spotify.com/v1/playlists/${process.env.PLAYLISTID}/tracks`,
            headers: {
                'Authorization': `Bearer ${authinfo.access_token}`
            },
            data: {
                uris: tracks.slice(0, 100)
            }
        }
        tracks.splice(0, 100)
        var replaceListResponse = await axios(replaceList)
        console.log(JSON.stringify(replaceListResponse.data))

        while (tracks.length > 0) {
            var addToList = {
                method: 'post',
                url: `https://api.spotify.com/v1/playlists/${process.env.PLAYLISTID}/tracks`,
                headers: {
                    'Authorization': `Bearer ${authinfo.access_token}`
                },
                data: {
                    uris: tracks.slice(0, 100)
                }
            }
            tracks.splice(0, 100)
            var addToListResponse = await axios(addToList)
            console.log(JSON.stringify(addToListResponse.data))
        }
        req.sendStatus(200)
        database.close()
    })
})

app.listen(8080, () => {
    console.log(`Listening at http://localhost:${8080}`)
})