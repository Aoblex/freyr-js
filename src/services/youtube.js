/* eslint-disable max-classes-per-file, no-underscore-dangle */
const util = require('util');

const got = require('got').default;
const Promise = require('bluebird');
const ytSearch = require('yt-search');
const youtubedl = require('youtube-dl');

const most = require('../most_polyfill');
const symbols = require('../symbols');

const _ytdlGet = util.promisify(youtubedl.getInfo);

function YouTubeSearchError(message, statusCode, status, body) {
  this.name = 'YouTubeSearchError';
  this.message = message || '';
  if (status) this.status = status;
  if (statusCode) this.statusCode = statusCode;
  if (body) this.body = body;
}

YouTubeSearchError.prototype = Error.prototype;

function genAsyncGetFeedsFn(url) {
  return async () => _ytdlGet(url, ['--socket-timeout=20', '--retries=20', '--no-cache-dir']);
}

function attachFeedFn(collections, generator) {
  generator = generator || (v => v);
  return collections.map(item => ({...item, getFeeds: genAsyncGetFeedsFn(generator(item))}));
}

class YouTubeMusic {
  static [symbols.meta] = {
    ID: 'yt_music',
    DESC: 'YouTube Music',
    PROPS: {
      isQueryable: false,
      isSearchable: true,
      isSourceable: true,
    },
    BITRATES: [96, 128, 160, 192, 256, 320],
  };

  [symbols.meta] = YouTubeMusic[symbols.meta];

  gotInstance = got.extend({
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.132 Safari/537.36',
    },
  });

  apiKey = null;

  async request(url, opts) {
    const response = await this.gotInstance(url, opts).catch(err =>
      Promise.reject(
        new YouTubeSearchError(err.message, err.response && err.response.statusCode, err.code, err.response && err.response.body),
      ),
    );
    return response.body;
  }

  async getApiKey(force = false) {
    if (this.apiKey && !force) return this.apiKey;
    const body = await this.request('https://music.youtube.com/', {method: 'get'});
    let match;
    if ((match = (body || '').match(/(?="INNERTUBE_API_KEY":"(.+?)")/))) return ([, this.apiKey] = match), this.apiKey;
    throw new YouTubeSearchError('Failed to extract `INNERTUBE_API_KEY`');
  }

  async _search(queryObject, params, tag) {
    if (typeof queryObject !== 'object') throw new Error('<queryObject> must be an object');
    if (params && typeof params !== 'object') throw new Error('<params>, if defined must be an object');
    const response = await this.request('https://music.youtube.com/youtubei/v1/search', {
      timeout: 10000,
      method: 'post',
      searchParams: {alt: 'json', key: await this.getApiKey(), ...params},
      responseType: 'json',
      json: {
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: '0.1',
            hl: 'en',
            gl: 'US',
          },
        },
        ...queryObject,
      },
      headers: {
        referer: 'https://music.youtube.com/search',
      },
    });
    const shelf = !('continuationContents' in response)
      ? response.contents.sectionListRenderer.contents.map(section => section.musicShelfRenderer || section)
      : [response.continuationContents.musicShelfContinuation || response.continuationContents.sectionListContinuation];
    return Object.fromEntries(
      shelf.map(layer => {
        const layerName = layer.title && layer.title.runs[0].text;
        return [
          layerName === 'Top result'
            ? 'top'
            : layerName === 'Songs'
            ? 'songs'
            : layerName === 'Videos'
            ? 'videos'
            : layerName === 'Albums'
            ? 'albums'
            : layerName === 'Artists'
            ? 'artists'
            : layerName === 'Playlists'
            ? 'playlists'
            : `other${layerName ? `(${layerName})` : ''}`,
          {
            contents: (layer.contents || []).map(content => {
              content = content.musicResponsiveListItemRenderer;
              const tags = content.flexColumns.map(obj =>
                obj.musicResponsiveListItemFlexColumnRenderer.text.runs.map(side => side.text).join(''),
              );
              const type = tag || tags.splice(1, 1)[0];
              return type === 'Song'
                ? {
                    title: tags[0],
                    type,
                    artists: tags[1],
                    album: tags[2],
                    duration: tags[3],
                    link: content.doubleTapCommand.watchEndpoint,
                  }
                : type === 'Video'
                ? {
                    title: tags[0],
                    type,
                    artists: tags[1],
                    views: tags[2],
                    duration: tags[3],
                    link: content.doubleTapCommand.watchEndpoint,
                  }
                : type === 'Album'
                ? {
                    name: tags[0],
                    type,
                    album_type: type === 'Single' ? 'Album' : type,
                    artists: tags[1],
                    year: tags[2],
                    link: content.doubleTapCommand.watchPlaylistEndpoint,
                  }
                : type === 'Artist'
                ? {
                    name: tags[0],
                    type,
                    subscribers: tags[1],
                    link: content.doubleTapCommand.watchPlaylistEndpoint,
                  }
                : type === 'Playlist'
                ? {
                    name: tags[0],
                    type,
                    author: tags[1],
                    nb_songs: tags[2],
                    link: content.doubleTapCommand.watchPlaylistEndpoint,
                  }
                : {};
            }),
            ...(layerName === 'Top result'
              ? null
              : {
                  loadMore: !layer.continuations
                    ? undefined
                    : async () => {
                        const continuationObject = layer.continuations[0].nextContinuationData;
                        return (
                          await this._search(
                            {},
                            {
                              icit: continuationObject.clickTrackingParams,
                              continuation: continuationObject.continuation,
                            },
                            tag || layerName.slice(0, -1),
                          )
                        ).other;
                      },
                  expand: !layer.bottomEndpoint
                    ? undefined
                    : async () =>
                        (await this._search(layer.bottomEndpoint.searchEndpoint, {}, tag || layerName.slice(0, -1))).other,
                }),
          },
        ];
      }),
    );
  }

  async search(artists, track, duration) {
    const results = await this._search({query: artists.concat(track).join(' ')});
    const validSections = [
      ...results.top.contents, // top recommended songs
      ...results.songs.contents, // song section
      ...results.videos.contents, // videos section
    ];
    function calculateAccuracyFor(item) {
      // get weighted delta from expected duration
      const durationDelta = 100 - (Math.abs(duration - item.duration_ms) / duration) * 100;
      // if item is a song, bump remaining by 80%, if video, bump up by 70%, anything else, not so much
      const accuracy =
        durationDelta + (res => ((item.type === 'Song' ? 80 : item.type === 'Video' ? 70 : 10) / 100) * res)(100 - durationDelta);
      return accuracy;
    }
    const classified = Object.values(
      validSections.reduce((final, item) => {
        // prune duplicates
        if (!(item.link.videoId in final)) {
          final[item.link.videoId] = {
            title: item.title,
            type: item.type,
            artists: item.artists,
            album: item.album,
            duration: item.duration,
            duration_ms: item.duration.split(':').reduce((acc, time) => 60 * acc + +time) * 1000,
            videoId: item.link.videoId,
            playlistId: item.link.playlistId,
            getFeeds: genAsyncGetFeedsFn(item.videoId),
          };
          final[item.link.videoId].accuracy = calculateAccuracyFor(final[item.link.videoId]);
        }
        return final;
      }, {}),
      // sort descending by accuracy
    ).sort((a, b) => (a.accuracy > b.accuracy ? -1 : 1));
    return classified;
  }
}

class YouTube {
  static [symbols.meta] = {
    ID: 'youtube',
    DESC: 'YouTube',
    PROPS: {
      isQueryable: false,
      isSearchable: true,
      isSourceable: true,
    },
    BITRATES: [96, 128, 160, 192, 256, 320],
  };

  [symbols.meta] = YouTube[symbols.meta];

  _search = util.promisify(ytSearch);

  async _get(artists, trackTitle, xFilters, count = Infinity) {
    return (
      await this._search({
        query: [...artists, trackTitle, ...xFilters].join(' '),
        pageStart: 1,
        pageEnd: 2,
      })
    ).videos.reduce((all, item) => {
      if (
        all.length < count &&
        most(artists, keyWord => item.title.toLowerCase().includes(keyWord.toLowerCase())) &&
        item.title.toLowerCase().includes(trackTitle.toLowerCase()) &&
        !/\d+D/i.test(item.title)
      )
        all.push({...item, xFilters});
      return all;
    });
  }

  async search(artists, track, duration) {
    const searchResults = await Promise.map(
      [
        [artists, track, ['Official Audio'], 5],
        [artists, track, ['Audio'], 5],
        [artists, track, ['Lyrics'], 5],
        [artists, track, [], 5],
      ],
      query => Promise.resolve(this._get(...query)).reflect(),
      {concurrency: 3},
    );
    const classified = YouTube.classify(
      searchResults.flatMap(ret => (ret.isFulfilled() ? ret.value() : [])),
      artists,
      duration,
    );
    return attachFeedFn(classified, item => item.videoId);
  }

  static classify(stacks, artists, duration) {
    const highestViews = Math.max(...stacks.map(video => video.views));
    function bumpWith(video, accuracy) {
      return (x => x + (video.views === highestViews ? (60 / 100) * (100 - accuracy) : 0))(
        accuracy +
          (most(artists, artist => video.author.name.toLowerCase().includes(artist.toLowerCase()))
            ? (60 / 100) * (100 - accuracy)
            : 0),
      );
    }
    return Object.values(
      stacks.reduce((final, item) => {
        if (!(item.videoId in final))
          final[item.videoId] = {
            ...item,
            accuracy: bumpWith(item, ((duration - Math.abs(duration - item.seconds * 1000)) / duration) * 100),
          };
        return final;
      }, {}),
    ).sort((a, b) => (a.accuracy > b.accuracy ? -1 : a.accuracy < b.accuracy ? 1 : 0));
  }
}

module.exports = {YouTube, YouTubeMusic};
