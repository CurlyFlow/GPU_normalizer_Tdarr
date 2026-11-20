"""Configured bounded reads and narrowly scoped post-cleanup FileDB removal."""
import json
import urllib.parse
import urllib.request

from arr_import_recovery import bounded_request


def configured_transport(config):
    if (not isinstance(config, dict) or set(config) != {'serverURL', 'apiKey'}
            or not isinstance(config['serverURL'], str) or not isinstance(config['apiKey'], str)):
        raise ValueError('An explicit Tdarr runtime connection is required')
    url = urllib.parse.urlsplit(config['serverURL'])
    if (url.scheme not in {'http', 'https'} or not url.hostname or url.username
            or url.password or url.query or url.fragment or url.path not in {'', '/'}):
        raise ValueError('Unsupported configured Tdarr API origin')
    host = '127.0.0.1' if url.hostname == '0.0.0.0' else url.hostname
    if ':' in host:
        host = '[' + host + ']'
    origin = f'{url.scheme}://{host}' + (f':{url.port}' if url.port else '')

    def request(collection, mode, doc_id):
        if (collection, mode) not in {('StagedJSONDB', 'getAll'), ('FileJSONDB', 'getById'), ('FileJSONDB', 'removeOne')}:
            raise ValueError('Unsupported runtime database operation')
        body = {'data': {'collection': collection, 'mode': mode, 'docID': doc_id}}
        call = urllib.request.Request(origin + '/api/v2/cruddb', json.dumps(body).encode(),
                                      {'Content-Type': 'application/json', 'x-api-key': config.get('apiKey', '')})
        response = bounded_request(call, 20)
        return json.loads(response) if response else None
    return request


def configured_reader(config):
    request = configured_transport(config)
    def read(collection, mode, doc_id):
        if (collection, mode) not in {('StagedJSONDB', 'getAll'), ('FileJSONDB', 'getById')}:
            raise ValueError('Unsupported runtime read')
        return request(collection, mode, doc_id)
    return read


def configured_file_remover(config):
    request = configured_transport(config)
    def remove(file):
        from pathlib import Path
        path = Path(file)
        if not path.is_absolute() or '..' in path.parts or '\x00' in file or path.exists():
            raise ValueError('FileDB cleanup requires an exact already-absent media file')
        request('FileJSONDB', 'removeOne', file)
        if request('FileJSONDB', 'getById', file):
            raise ValueError('FileDB cleanup was not acknowledged')
    return remove
