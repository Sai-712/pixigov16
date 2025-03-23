import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { s3Client, S3_BUCKET_NAME, rekognitionClient } from '../config/aws';
import { Camera, X, ArrowLeft, Download, Upload as UploadIcon, Copy } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
  IndexFacesCommand,
  SearchFacesCommand,
  CreateCollectionCommand,
  ListCollectionsCommand
} from '@aws-sdk/client-rekognition';
import { Link, useNavigate } from 'react-router-dom';

interface ViewEventProps {
  eventId: string;
  selectedEvent?: string;
  onEventSelect?: (eventId: string) => void;
}

interface EventImage {
  url: string;
  key: string;
}

interface FaceRecordWithImage {
  faceId: string;
  boundingBox?: { Left: number; Top: number; Width: number; Height: number };
  image: EventImage;
}

interface FaceGroups {
  [groupId: string]: FaceRecordWithImage[];
}

/**
 * A small helper component that displays one face as a 96×96 circular thumbnail,
 * zooming and centering on the face bounding box.
 */
const FaceThumbnail: React.FC<{
  faceRec: FaceRecordWithImage;
  onClick: () => void;
}> = ({ faceRec, onClick }) => {
  const { image, boundingBox } = faceRec;

  // We interpret boundingBox as fractions of the original image:
  // boundingBox.Left, boundingBox.Top, boundingBox.Width, boundingBox.Height are in [0..1].
  // We'll place an absolutely positioned <img> inside a 96×96 container.
  // Then use transform to scale & shift the face center to the middle.

  const containerSize = 96; // px
  const centerX = boundingBox ? boundingBox.Left + boundingBox.Width / 2 : 0.5;
  const centerY = boundingBox ? boundingBox.Top + boundingBox.Height / 2 : 0.5;
  // Scale so that the bounding box is at least the container size in both width & height.
  // If boundingBox.Width = 0.2, then scale ~ 1 / 0.2 = 5 => we clamp to some max to avoid extremes.
  let scale = boundingBox
    ? 1 / Math.min(boundingBox.Width, boundingBox.Height)
    : 1;
  scale = Math.max(1.2, Math.min(scale, 2)); // clamp scale between [1.2..3] for better face visibility

  // We'll shift the image so that the face center ends up at the container's center (48px, 48px).
  // The face center in the image's local coordinate space (before scaling) is at
  // (centerX * imageWidth, centerY * imageHeight).
  // Because we're using fractional bounding boxes, we treat the image as if it's 1×1, 
  // then scaled to 'scale', so the face center is at (centerX * scale, centerY * scale) in "image" space.
  // We want that point to appear at (0.5, 0.5) in the container, i.e. 50% 50% of the container.
  // We'll do a trick: set transform-origin to top-left (0,0), then use translateX/Y to push the center to 50% of container.

  // The translation in fraction-of-container is:
  //   xTranslate = 0.5*containerSize - (centerX * containerSize * scale)
  //   yTranslate = 0.5*containerSize - (centerY * containerSize * scale)
  // We'll just compute them in px for clarity.
  const xTranslate = 0.5 * containerSize - centerX * containerSize * scale;
  const yTranslate = 0.5 * containerSize - centerY * containerSize * scale;

  const thumbnailStyle: React.CSSProperties = {
    width: `${containerSize}px`,
    height: `${containerSize}px`,
    borderRadius: '9999px',
    overflow: 'hidden',
    position: 'relative',
    cursor: 'pointer'
  };

  const imgStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    // We'll assume a base size of containerSize for the image. 
    // Because we only have fractions, this is approximate.
    width: `${containerSize}px`,
    height: 'auto',
    transform: `translate(${xTranslate}px, ${yTranslate}px) scale(${scale})`,
    transformOrigin: 'top left',
    // If the image is originally landscape, 'height: auto' might not fill the container vertically.
    // But objectFit won't apply because we have an absolutely positioned element.
    // This approach still tends to produce a better face crop than background methods if bounding boxes are correct.
  };

  return (
    <div style={thumbnailStyle} onClick={onClick}>
      <img src={image.url} alt="face" style={imgStyle} />
    </div>
  );
};

const ViewEvent: React.FC<ViewEventProps> = ({ eventId, selectedEvent, onEventSelect }) => {
  const navigate = useNavigate();
  const [images, setImages] = useState<EventImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedImage, setSelectedImage] = useState<EventImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showCopySuccess, setShowCopySuccess] = useState(false);
  const [showQRModal, setShowQRModal] = useState(false);

  const [faceGroups, setFaceGroups] = useState<FaceGroups>({});
  const [allFaceRecords, setAllFaceRecords] = useState<FaceRecordWithImage[]>([]);

  const qrCodeRef = useRef<SVGSVGElement>(null);

  // Ensure a Rekognition collection exists for this event.
  const ensureCollection = async (collectionId: string) => {
    try {
      const listResponse = await rekognitionClient.send(new ListCollectionsCommand({}));
      const collections = listResponse.CollectionIds || [];
      if (!collections.includes(collectionId)) {
        await rekognitionClient.send(new CreateCollectionCommand({ CollectionId: collectionId }));
      }
    } catch (error) {
      console.error('Error ensuring collection:', error);
    }
  };

  const handleDownload = useCallback(async (url: string) => {
    try {
      const response = await fetch(url, {
        mode: 'cors',
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.statusText}`);
      }
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('image/')) {
        throw new Error('Invalid image format received');
      }
      const blob = await response.blob();
      const fileName = decodeURIComponent(url.split('/').pop() || 'image.jpg');
      const link = document.createElement('a');
      link.href = window.URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(link.href);
    } catch (error) {
      console.error('Error downloading image:', error);
      throw error;
    }
  }, []);

  /**
   * detectAndGroupFaces: two-phase approach
   *
   * PHASE 1: Index each image. If multiple faces exist, Rekognition returns multiple FaceRecords.
   *          We store them in "allFaceRecords".
   *
   * PHASE 2: For each faceRecord, call SearchFaces by faceId to see if it matches existing faces.
   *          If matched, reuse groupId; if not, create a new groupId. Then build "faceGroups".
   */
  const detectAndGroupFaces = async (imagesToProcess: EventImage[]) => {
    const collectionId = eventId;
    await ensureCollection(collectionId);

    const tempFaceRecords: FaceRecordWithImage[] = [];

    // PHASE 1: Index all images
    await Promise.all(
      imagesToProcess.map(async (image) => {
        try {
          const indexResponse = await rekognitionClient.send(
            new IndexFacesCommand({
              CollectionId: collectionId,
              Image: {
                S3Object: {
                  Bucket: S3_BUCKET_NAME,
                  Name: image.key
                }
              },
              DetectionAttributes: [],
              ExternalImageId: 'placeholder'
            })
          );

          if (indexResponse.FaceRecords) {
            for (const rec of indexResponse.FaceRecords) {
              if (rec.Face?.FaceId) {
                tempFaceRecords.push({
                  faceId: rec.Face.FaceId,
                  boundingBox: rec.Face.BoundingBox as {
                    Left: number;
                    Top: number;
                    Width: number;
                    Height: number;
                  },
                  image
                });
              }
            }
          }
        } catch (error) {
          console.error(`Error indexing image ${image.key}:`, error);
        }
      })
    );

    setAllFaceRecords(tempFaceRecords);

    // PHASE 2: Search & group
    const faceIdToGroupId: Record<string, string> = {};
    let groupCount = 0;

    await Promise.all(
      tempFaceRecords.map(async (faceRec) => {
        try {
          const searchResponse = await rekognitionClient.send(
            new SearchFacesCommand({
              CollectionId: collectionId,
              FaceId: faceRec.faceId,
              MaxFaces: 5,
              FaceMatchThreshold: 99
            })
          );
          if (searchResponse.FaceMatches && searchResponse.FaceMatches.length > 0) {
            const matchedGroupIds = searchResponse.FaceMatches
              .map((m) => m.Face?.FaceId)
              .filter((id): id is string => !!id)
              .map((id) => faceIdToGroupId[id])
              .filter((gid): gid is string => !!gid);

            if (matchedGroupIds.length > 0) {
              faceIdToGroupId[faceRec.faceId] = matchedGroupIds[0];
            } else {
              groupCount += 1;
              faceIdToGroupId[faceRec.faceId] = `group_${groupCount}`;
            }
          } else {
            groupCount += 1;
            faceIdToGroupId[faceRec.faceId] = `group_${groupCount}`;
          }
        } catch (err) {
          console.error(`SearchFaces error for faceId ${faceRec.faceId}:`, err);
          groupCount += 1;
          faceIdToGroupId[faceRec.faceId] = `group_${groupCount}`;
        }
      })
    );

    const newGroups: FaceGroups = {};
    for (const faceRec of tempFaceRecords) {
      const gid = faceIdToGroupId[faceRec.faceId];
      if (!newGroups[gid]) {
        newGroups[gid] = [];
      }
      newGroups[gid].push(faceRec);
    }

    setFaceGroups(newGroups);
  };

  useEffect(() => {
    const path = window.location.pathname;
    if (path.includes('upload_selfie') || path.includes('upload-selfie')) {
      const userEmail = localStorage.getItem('userEmail');
      if (!userEmail) {
        setError('Authentication required. Please log in.');
        return;
      }
      if (path !== `/upload-selfie/${eventId}`) {
        navigate(`/upload-selfie/${eventId}`, { state: { eventId }, replace: true });
        return;
      }
    }
  }, [eventId, navigate]);

  useEffect(() => {
    fetchEventImages();
    if (selectedEvent && onEventSelect) {
      onEventSelect(selectedEvent);
    }
  }, [eventId, selectedEvent]);

  const fetchEventImages = async () => {
    try {
      const eventToUse = selectedEvent || eventId;
      const prefixes = [`events/shared/${eventToUse}/images`];
      let allImages: EventImage[] = [];
      let fetchError: any = null;

      for (const prefix of prefixes) {
        try {
          const listCommand = new ListObjectsV2Command({
            Bucket: S3_BUCKET_NAME,
            Prefix: prefix
          });
          const result = await s3Client.send(listCommand);
          if (result.Contents) {
            const imageItems = result.Contents
              .filter((item) => item.Key && item.Key.match(/\.(jpg|jpeg|png)$/i))
              .map((item) => ({
                url: `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${item.Key}`,
                key: item.Key || ''
              }));
            allImages = [...allImages, ...imageItems];
          }
        } catch (error) {
          fetchError = error;
          console.error(`Error fetching from path ${prefix}:`, error);
          continue;
        }
      }

      if (allImages.length > 0) {
        setImages(allImages);
        await detectAndGroupFaces(allImages);
        setError(null);
      } else if (fetchError) {
        throw fetchError;
      } else {
        setError('No images found for this event.');
      }
    } catch (error: any) {
      console.error('Error fetching event images:', error);
      setError(error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files || e.target.files.length === 0) return;
      const userEmail = localStorage.getItem('userEmail');
      if (!userEmail) throw new Error('User not authenticated');

      setUploading(true);
      const files = Array.from(e.target.files);

      try {
        await Promise.all(
          files.map(async (file) => {
            const key = `events/shared/${eventId}/images/${Date.now()}-${file.name}`;
            const buffer = await file.arrayBuffer();
            const uint8Array = new Uint8Array(buffer);

            const upload = new Upload({
              client: s3Client,
              params: {
                Bucket: S3_BUCKET_NAME,
                Key: key,
                Body: uint8Array,
                ContentType: file.type,
                Metadata: {
                  'event-id': eventId,
                  'session-id': localStorage.getItem('sessionId') || '',
                  'upload-date': new Date().toISOString()
                }
              },
              partSize: 5 * 1024 * 1024,
              leavePartsOnError: false
            });

            upload.on('httpUploadProgress', (progress) => {
              const percentage = Math.round(
                ((progress.loaded || 0) * 100) / (progress.total || 1)
              );
              setUploadProgress(percentage);
            });

            await upload.done();
          })
        );

        await fetchEventImages();
      } catch (error: any) {
        console.error('Error uploading images:', error);
        setError(error.message || 'Failed to upload images. Please try again.');
      } finally {
        setUploading(false);
        setUploadProgress(0);
      }
    },
    [eventId]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="text-center p-8">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary mx-auto"></div>
          <p className="mt-4 text-black-600">Loading event images...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="text-center p-8 bg-white rounded-lg shadow-lg">
          <div className="text-blue-500 mb-4">⚠️</div>
          <p className="text-gray-800">{error}</p>
          <Link to="/upload" className="mt-4 inline-flex items-center text-primary hover:text-secondary">
            <ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
            Click to Upload images
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="container mx-auto px-4 py-4 sm:py-8">
        {/* Header and controls */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 sm:gap-8 mb-4 sm:mb-8">
          <Link
            to="/events"
            className="flex items-center text-gray-600 hover:text-primary transition-colors"
          >
            <ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
            Back to Events
          </Link>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-800">Event Gallery</h1>
            <div className="flex flex-wrap items-center gap-2 sm:gap-4">
              <div className="flex items-center gap-2 sm:gap-4">
                <button
                  onClick={() => setShowQRModal(true)}
                  className="bg-blue-200 text-black py-2 px-3 sm:px-4 rounded-lg hover:bg-secondary transition-colors duration-200 flex items-center text-sm sm:text-base"
                >
                  <QRCodeSVG
                    ref={qrCodeRef}
                    value={`${window.location.origin}/upload-selfie/${eventId}?source=qr`}
                    size={24}
                    level="H"
                    includeMargin={true}
                  />
                  <span className="ml-2">Show QR Code</span>
                </button>
              </div>
              {showQRModal && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-2 sm:p-4">
                  <div className="bg-blue-200 rounded-lg p-4 sm:p-6 max-w-[90vw] sm:max-w-sm w-full">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="text-xl font-semibold">Scan QR Code</h3>
                      <button
                        onClick={() => setShowQRModal(false)}
                        className="text-gray-500 hover:text-gray-700"
                      >
                        <X className="w-6 h-6" />
                      </button>
                    </div>
                    <div className="flex flex-col items-center space-y-4">
                      <QRCodeSVG
                        value={`${window.location.origin}/upload-selfie/${eventId}?source=qr`}
                        size={200}
                        level="H"
                        includeMargin={true}
                        bgColor="#FFFFFF"
                        fgColor="#000000"
                      />
                      <div className="flex flex-col sm:flex-row gap-2 w-full">
                        <button
                          onClick={() => {
                            if (!qrCodeRef.current) return;
                            const canvas = document.createElement('canvas');
                            const svgData = new XMLSerializer().serializeToString(qrCodeRef.current);
                            const img = new Image();
                            img.onload = () => {
                              canvas.width = img.width;
                              canvas.height = img.height;
                              const ctx = canvas.getContext('2d');
                              ctx!.drawImage(img, 0, 0);
                              canvas.toBlob((blob) => {
                                if (!blob) return;
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = `selfie-upload-qr-${eventId}.png`;
                                a.click();
                                URL.revokeObjectURL(url);
                              });
                            };
                            img.src = 'data:image/svg+xml;base64,' + btoa(svgData);
                          }}
                          className="flex-1 bg-blue-500 text-white py-2 px-4 rounded-lg hover:bg-secondary transition-colors duration-200 flex items-center justify-center"
                        >
                          <Download className="w-5 h-5 mr-2" />
                          Download QR
                        </button>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(
                              `${window.location.origin}/upload-selfie/${eventId}?source=share`
                            );
                            setShowCopySuccess(true);
                            setTimeout(() => setShowCopySuccess(false), 2000);
                          }}
                          className="flex-1 bg-primary text-white py-2 px-4 rounded-lg hover:bg-secondary transition-colors duration-200 flex items-center justify-center"
                        >
                          <Copy className="w-5 h-5 mr-2" />
                          {showCopySuccess ? 'Copied!' : 'Share Link'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
            {images.length > 0 && (
              <button
                onClick={() => {
                  images.forEach((image, index) => {
                    setTimeout(() => {
                      handleDownload(image.url);
                    }, index * 500);
                  });
                }}
                className="bg-blue-200 text-black py-2 px-3 sm:px-4 rounded-lg hover:bg-secondary transition-colors duration-200 flex items-center text-sm sm:text-base whitespace-nowrap"
              >
                <Download className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
                Download All
              </button>
            )}
            <label className="cursor-pointer bg-blue-200 text-black py-2 px-3 sm:px-4 rounded-lg hover:bg-secondary transition-colors duration-200 flex items-center text-sm sm:text-base whitespace-nowrap">
              <UploadIcon className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
              Upload Images
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileChange}
                className="hidden"
              />
            </label>
          </div>
        </div>

        {uploading && (
          <div className="mb-4">
            <div className="w-full bg-gray-200 rounded-full h-2.5">
              <div
                className="bg-primary h-2.5 rounded-full transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <p className="text-center text-sm text-gray-600 mt-2">
              Uploading... {uploadProgress}%
            </p>
          </div>
        )}

        {/* Face thumbnails horizontal scrollable list */}
        <div className="sticky top-0 z-10 bg-white/95 backdrop-blur-sm shadow-sm py-4">
          <div className="mb-2">
            <h2 className="text-xl font-semibold text-gray-900">People in Event</h2>
            <p className="text-gray-600 text-sm">
              Our AI is{' '}
              92% accurate
              and still learning, yet your data is safe.
            </p>
          </div>

          <div className="flex overflow-x-auto pb-4 space-x-4 scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-transparent">
            {Object.entries(faceGroups).map(([groupId, faceRecs]) => {
              const faceRec = faceRecs[0];
              if (!faceRec.image) return null;

              return (
                <div key={groupId}>
                  <FaceThumbnail
                    faceRec={faceRec}
                    onClick={() => {
                      // When clicked, show all images that contain this face
                      const relatedImages = faceRecs.map((rec) => rec.image);
                      setImages(relatedImages);
                    }}
                  />
                </div>
              );
            })}
            {/* 'All' thumbnail to reset */}
            <div
              className="flex-none w-24 h-24 rounded-full border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-400 cursor-pointer hover:border-gray-400 transition-colors duration-300"
              onClick={() => fetchEventImages()}
            >
              All
            </div>
          </div>
        </div>

        <div className="space-y-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-gray-900">Event Photos</h2>
            <div className="flex space-x-2"></div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {images.map((image, idx) => (
              <div
                key={image.key}
                className="relative aspect-square overflow-hidden rounded-lg shadow-md cursor-pointer transform hover:scale-105 transition-transform duration-300"
                onClick={() => setSelectedImage(image)}
              >
                <img
                  src={image.url}
                  alt={`Event photo ${idx + 1}`}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
                {/* Download button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDownload(image.url);
                  }}
                  className="absolute top-2 right-2 p-1 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors duration-200"
                >
                  <Download className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {images.length === 0 && (
          <div className="text-center py-16 bg-gray-50 rounded-lg">
            <Camera className="w-16 h-16 text-gray-400 mx-auto mb-4" />
            <p className="text-xl text-gray-600">No images found for this event</p>
            <p className="text-gray-400 mt-2">
              Images uploaded to this event will appear here
            </p>
          </div>
        )}

        {selectedImage && (
          <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center z-50 p-4">
            <button
              className="absolute top-4 right-4 text-white hover:text-gray-300 transition-colors"
              onClick={() => setSelectedImage(null)}
            >
              <X className="w-8 h-8" />
            </button>
            <img
              src={selectedImage.url}
              alt="Selected event image"
              className="max-w-full max-h-[90vh] object-contain"
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default ViewEvent;