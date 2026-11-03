# Readeck

Browse and download articles from Readeck (readeck.org) as EPUB to read offline.

- Browse Unread, Favorites, Archive, All articles, or any of your tags
- Search for specific articles
- Highlights and notes made in Readeck are included in downloaded articles
- Download every article with a tag, and hide articles with an "Ignore" tag
- Reading progress is synced back to Readeck when joining WiFi or putting the reader to sleep
- Highlights made on the reader are sent to Readeck when syncing from the plugin settings

## Accessing plugin settings

- Make sure you're on the same WiFi network as the reader
- From the home screen, choose File Transfer -> Join Network
- Go to the URL that is displayed
- Select "Plugins" and scroll down to find Readeck

## Signing in to Readeck

- Enter your Readeck URL and click "Sign in"
- You will see a link to /device on your Readeck instance as well as a code
- Enter the code in Readeck and then select "Authorize"

You can also create an API token in Readeck, expand "Use an API token instead", and paste it in. Older versions of Readeck without OAuth need an API token.

## Browsing articles

- From the home screen, choose Plugins -> Readeck and pick a list or tag
- Select an article to download it
- Downloaded articles are placed in the Readeck folder on the SD card

## Downloading all articles with a tag

- In the plugin settings, put in a comma-separated list of tags under "Always download"
- Articles that also have an "Ignore" tag, and archived articles, are skipped
- Click "Sync now". Downloads only happen when it is clicked
